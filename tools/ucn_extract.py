#!/usr/bin/env python3
"""Unpack a .ucn file and turn its script.xml into a per-page timeline.

Usage: python3 ucn_extract.py INPUT.ucn OUTDIR

Writes OUTDIR/assets/* (every embedded file), OUTDIR/script.xml and
OUTDIR/story.json. See docs/UCN_FORMAT.md for the container layout.
"""
import json
import os
import struct
import sys
import zlib
import xml.etree.ElementTree as ET

LFH = b'\x03\x04'


def decode_name(raw):
    """Entry names are hex text; the bytes it spells use a 1/2/3-byte scheme."""
    b = bytes.fromhex(raw.decode('ascii'))
    out, i = [], 0
    while i < len(b):
        if b[i] == 0xFF:  # escape: next two bytes are a code point (e.g. U+3131)
            out.append(chr(b[i + 1] << 8 | b[i + 2]))
            i += 3
        elif b[i] < 0x80:  # plain ASCII
            out.append(chr(b[i]))
            i += 1
        else:  # code point >= U+8000, big-endian
            out.append(chr(b[i] << 8 | b[i + 1]))
            i += 2
    return ''.join(out)


def read_entries(data):
    """Yield (name, payload) for each local file header after the 16-byte prefix."""
    off = 16
    while data[off + 2:off + 4] == LFH and data[off:off + 2] in (b'UC', b'PK'):
        (_ver, _flags, _method, _time, _date, crc, csize, _usize,
         nlen, elen) = struct.unpack('<HHHHHIIIHH', data[off + 4:off + 30])
        name = decode_name(data[off + 30:off + 30 + nlen])
        start = off + 30 + nlen + elen
        blob = data[start:start + csize]
        if zlib.crc32(blob) & 0xffffffff != crc:
            raise ValueError(f'CRC mismatch for {name}')
        # Header says "stored", but the stored bytes are a zlib stream.
        yield name, zlib.decompress(blob)
        off = start + csize


def num(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def effects(node):
    return {e.get('type'): {'effect': e.get('effect'), 'time': num(e.get('time'))}
            for e in node.findall('effect')}


def build_story(root):
    system = {o.get('parameter'): dict(o.attrib) for o in root.iter('option')}
    size = system.get('size', {})

    resources = {}
    for obj in root.find('global/resource').iter('object'):
        f = obj.find('file')
        resources[obj.get('id')] = {
            'type': obj.get('type'),
            'advtype': obj.get('advtype') or '',
            'file': f.get('name') if f is not None else None,
            'itemId': obj.get('itemId'),
        }

    texts = {n.get('id'): n.text or '' for n in root.find('global/scenario')}

    scene = root.find('content/scene')
    total = num(scene.get('page'))
    pages = {p: {'page': p, 'advance': {'mode': 'click'}, 'background': None,
                 'images': [], 'texts': [], 'bgm': None} for p in range(1, total + 1)}

    def res(ref):
        r = resources.get(ref, {})
        return {'ref': ref, 'file': r.get('file')}

    order = 0
    for el in scene:
        if el.tag == 'delay':
            p = num(el.get('page'))
            if p in pages:
                # mode "scen": wait for the reader's click on the text;
                # "button": wait for an input box / timer; "click": a page without text waits for a tap;
                # mode "": advance on its own after `time` ms.
                if el.get('mode') in ('scen', 'click'):
                    pages[p]['advance'] = {'mode': 'click'}
                elif el.get('mode') == 'button':
                    pages[p]['advance'] = {'mode': 'input'}
                else:
                    pages[p]['advance'] = {'mode': 'auto', 'ms': num(el.get('time'))}
            continue
        for layer in el.findall('layer'):
            kind = layer.get('type')
            for n in layer.findall('node'):
                order += 1
                if kind == 'scenario':
                    p = num(n.get('page'))
                    if p in pages:
                        pages[p]['texts'].append({
                            'textId': n.get('ref'),
                            'text': texts.get(n.get('ref'), ''),
                            'x': num(n.get('x')), 'y': num(n.get('y')),
                            'width': num(n.get('width')), 'height': num(n.get('height')),
                            'align': n.get('align'), 'color': n.get('color'),
                            'background': n.get('background'),
                            'opacity': num(n.get('opacity')),
                            'vPadding': num(n.get('vPadding')),
                            'hPadding': num(n.get('hPadding')),
                            'leading': num(n.get('leading')),
                            'speed': num(n.get('speed')),
                            'border': num(n.get('border')),
                            'bordercolor': n.get('bordercolor'),
                            'radius': num(n.get('radius')),
                        })
                    continue
                start, end = num(n.get('start')), num(n.get('end'))
                if kind == 'image' and resources.get(n.get('ref'), {}).get('advtype') == 'timer':
                    # Countdown component; its picture is only a placeholder.
                    maxtime = num(root.find(f"global/resource//object[@id='{n.get('ref')}']").get('maxtime'), 10)
                    for p in range(max(start, 1), min(end, total) + 1):
                        pages[p].setdefault('timers', []).append({
                            'id': n.get('id'), 'seconds': maxtime, 'x': num(n.get('x')), 'y': num(n.get('y')),
                            'width': num(n.get('width')), 'height': num(n.get('height'))})
                    continue
                if kind == 'image' and resources.get(n.get('ref'), {}).get('advtype') == 'input':
                    # Input box component (name entry etc.); its picture is only a placeholder.
                    for p in range(max(start, 1), min(end, total) + 1):
                        pages[p].setdefault('inputs', []).append({
                            'id': n.get('id'), 'x': num(n.get('x')), 'y': num(n.get('y')),
                            'width': num(n.get('width')), 'height': num(n.get('height'))})
                    continue
                for p in range(max(start, 1), min(end, total) + 1):
                    item = dict(res(n.get('ref')), start=start, end=end)
                    if kind == 'bgm':
                        item.update(volume=num(n.get('volume'), 100),
                                    repeat=n.get('repeat'),
                                    fadeIn=float(n.get('fadein') or 0),
                                    fadeOut=float(n.get('fadeOut') or 0))
                        pages[p]['bgm'] = item
                        continue
                    item.update(x=num(n.get('x')), y=num(n.get('y')),
                                width=num(n.get('width')), height=num(n.get('height')),
                                z=num(n.get('z')), order=order, effects=effects(n),
                                hidden=n.get('hidden') == 'true')
                    if kind == 'back':
                        pages[p]['background'] = item
                    else:
                        pages[p]['images'].append(item)

    for pg in pages.values():
        pg['images'].sort(key=lambda i: (i['z'], i['order']))

    return {
        'width': num(size.get('width'), 800),
        'height': num(size.get('height'), 480),
        'font': system.get('font', {}).get('Fontname'),
        'fontSize': num(system.get('fontsize', {}).get('Fontsize'), 15),
        'owner': root.get('owner'),
        'pageCount': total,
        'script': (root.findtext('global/script') or '').strip(),
        'resources': resources,
        'pages': [pages[p] for p in sorted(pages)],
    }


def main():
    src, out = sys.argv[1], sys.argv[2]
    data = open(src, 'rb').read()
    os.makedirs(os.path.join(out, 'assets'), exist_ok=True)
    script = None
    for name, payload in read_entries(data):
        if name == 'script.xml':
            script = payload
            path = os.path.join(out, name)
        else:
            path = os.path.join(out, 'assets', os.path.basename(name))
        with open(path, 'wb') as f:
            f.write(payload)
    story = build_story(ET.fromstring(script))
    with open(os.path.join(out, 'story.json'), 'w', encoding='utf-8') as f:
        json.dump(story, f, ensure_ascii=False, indent=1)
    print(f"{story['pageCount']} pages, {len(story['resources'])} resources -> {out}")


if __name__ == '__main__':
    main()
