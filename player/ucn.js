// Reads a .ucn file in the browser: unpacks the archive and builds the
// per-page timeline. Mirrors tools/ucn_extract.py; see docs/UCN_FORMAT.md.
const UCN = (() => {
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };

  // Entry names are hex text; the bytes it spells use a 1/2/3-byte scheme.
  function decodeName(hex) {
    const b = [];
    for (let i = 0; i < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
    let out = '';
    for (let i = 0; i < b.length;) {
      if (b[i] === 0xff) { out += String.fromCharCode(b[i + 1] << 8 | b[i + 2]); i += 3; }
      else if (b[i] < 0x80) { out += String.fromCharCode(b[i]); i += 1; }
      else { out += String.fromCharCode(b[i] << 8 | b[i + 1]); i += 2; }
    }
    return out;
  }

  // Header says "stored", but the stored bytes are a zlib stream.
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unpack(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const entries = new Map();
    let off = 16;
    while (off + 30 <= u8.length && u8[off + 2] === 3 && u8[off + 3] === 4) {
      const csize = dv.getUint32(off + 18, true);
      const nlen = dv.getUint16(off + 26, true);
      const elen = dv.getUint16(off + 28, true);
      const hex = new TextDecoder('ascii').decode(u8.subarray(off + 30, off + 30 + nlen));
      const start = off + 30 + nlen + elen;
      entries.set(decodeName(hex), await inflate(u8.subarray(start, start + csize)));
      off = start + csize;
    }
    if (!entries.has('script.xml')) throw new Error('script.xml을 찾을 수 없습니다. .ucn 파일이 맞나요?');
    return entries;
  }

  const num = (v, d = 0) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  const base = (p) => p.split('/').pop();

  function effects(node) {
    const fx = {};
    for (const e of node.querySelectorAll(':scope > effect')) {
      fx[e.getAttribute('type')] = { effect: e.getAttribute('effect'), time: num(e.getAttribute('time')) };
    }
    return fx;
  }

  function buildStory(doc) {
    const opt = (p, a) => doc.querySelector(`system > option[parameter="${p}"]`)?.getAttribute(a);
    const resources = {};
    for (const o of doc.querySelectorAll('global > resource object')) {
      resources[o.getAttribute('id')] = {
        type: o.getAttribute('type'),
        file: o.querySelector('file')?.getAttribute('name') ?? null,
      };
    }
    const texts = {};
    for (const n of doc.querySelectorAll('global > scenario > node')) texts[n.getAttribute('id')] = n.textContent;

    const scene = doc.querySelector('content > scene');
    const total = num(scene.getAttribute('page'));
    const pages = [];
    for (let p = 1; p <= total; p++) pages.push({ page: p, advance: { mode: 'click' }, background: null, images: [], text: null, bgm: null });

    let order = 0;
    for (const el of scene.children) {
      if (el.tagName === 'delay') {
        const pg = pages[num(el.getAttribute('page')) - 1];
        if (!pg) continue;
        // mode "scen": wait for the reader's click; mode "": advance after `time` ms.
        pg.advance = el.getAttribute('mode') === 'scen'
          ? { mode: 'click' } : { mode: 'auto', ms: num(el.getAttribute('time')) };
        continue;
      }
      for (const layer of el.querySelectorAll(':scope > layer')) {
        const kind = layer.getAttribute('type');
        for (const n of layer.querySelectorAll(':scope > node')) {
          order++;
          const a = (k) => n.getAttribute(k);
          if (kind === 'scenario') {
            const pg = pages[num(a('page')) - 1];
            if (pg) pg.text = {
              text: texts[a('ref')] ?? '', x: num(a('x')), y: num(a('y')),
              width: num(a('width')), height: num(a('height')), align: a('align') || 'center',
              color: a('color'), outline: a('outlinecolor'), outlineAlpha: num(a('outlineAlpha')),
              vPadding: num(a('vPadding')), hPadding: num(a('hPadding')), leading: num(a('leading')),
            };
            continue;
          }
          const ref = a('ref');
          const res = resources[ref] || {};
          const start = num(a('start')), end = num(a('end'));
          let item;
          if (kind === 'bgm') {
            item = { key: a('id'), ref, file: res.file, start, end };
          } else if (kind === 'back' || kind === 'image') {
            if (a('hidden') === 'true') continue;
            item = {
              key: a('id') || `n${order}`, ref, file: res.file && base(res.file), start, end,
              x: num(a('x')), y: num(a('y')), width: num(a('width')), height: num(a('height')),
              z: num(a('z')), order, effects: effects(n),
            };
          } else continue;
          for (let p = Math.max(start, 1); p <= Math.min(end, total); p++) {
            const pg = pages[p - 1];
            if (kind === 'bgm') pg.bgm = item;
            else if (kind === 'back') pg.background = item;
            else pg.images.push(item);
          }
        }
      }
    }
    for (const pg of pages) pg.images.sort((i, j) => i.z - j.z || i.order - j.order);

    return {
      width: num(opt('size', 'width'), 800),
      height: num(opt('size', 'height'), 480),
      font: opt('font', 'Fontname'),
      fontSize: num(opt('fontsize', 'Fontsize'), 15),
      pages,
    };
  }

  async function load(file) {
    const entries = await unpack(await file.arrayBuffer());
    const xml = new TextDecoder('utf-8').decode(entries.get('script.xml'));
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('script.xml을 읽지 못했습니다.');
    const urls = new Map();
    for (const [name, data] of entries) {
      if (name === 'script.xml') continue;
      const ext = name.split('.').pop().toLowerCase();
      urls.set(base(name), URL.createObjectURL(new Blob([data], { type: MIME[ext] || 'application/octet-stream' })));
    }
    return { story: buildStory(doc), urls };
  }

  return { load };
})();
