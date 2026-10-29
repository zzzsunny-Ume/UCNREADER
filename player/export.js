// "사진 전부 받기" (zip, stored) and "글 전부 저장" (txt) for a loaded .ucn.
const Export = (() => {
  function save(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // Minimal ZIP writer: no compression (images are already compressed), UTF-8 names.
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of files) {
      const nameBytes = enc.encode(name);
      const crc = UCN.crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 file name
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(local, nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  function images(data, title) {
    const list = [...data.files.values()].map((f) => ({ name: f.name.split('/').pop(), data: f.data }));
    if (!list.length) { Log.warn('저장할 사진이 없습니다'); return; }
    const blob = zip(list);
    save(blob, `${title}_사진.zip`);
    Log.ok(`사진 ${list.length}장 zip 저장 (${(blob.size / 1048576).toFixed(1)}MB)`);
  }

  // Same tag rule as the player: "$"/"#" up to the next ";" is a tag; "#p" and line breaks are new lines.
  function plain(text) {
    const s = text.replace(/#p/g, '\n').replace(/\r\n?/g, '\n');
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const semi = ch === '$' || ch === '#' ? s.indexOf(';', i) : -1;
      if (semi < 0) { out += ch; continue; }
      if (ch === '$') out += `[${s.slice(i + 1, semi)}]`;
      i = semi;
    }
    return out.trim();
  }

  const bgmName = (b) => b.ref.replace(/\(\d+\)$/, '').trim();

  function texts(data, title) {
    const lines = [title, `총 ${data.story.pages.length}장`, ''];
    let bgm = null, count = 0;
    for (const pg of data.story.pages) {
      if ((pg.bgm?.key ?? null) !== (bgm?.key ?? null)) {
        lines.push(pg.bgm ? `♪ ${bgmName(pg.bgm)}` : '♪ (음악 끝)', '');
        bgm = pg.bgm;
      }
      if (!pg.text) continue;
      lines.push(`[${pg.page}장]`, plain(pg.text.text), '');
      count++;
    }
    save(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' }), `${title}_글.txt`);
    Log.ok(`글 ${count}장 txt 저장`);
  }

  function log(title) {
    save(new Blob(['﻿' + Log.text().replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }), `${title}_log.txt`);
  }

  return { images, texts, log };
})();
