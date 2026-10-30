// Reads a .ucn file in the browser: unpacks the archive and builds the
// per-page timeline. Mirrors tools/ucn_extract.py; see docs/UCN_FORMAT.md.
// Every step reports to Log so readers can send the log when a file fails.
const UCN = (() => {
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
  const KNOWN_LAYERS = new Set(['scenario', 'back', 'bgm', 'image', 'effect', 'group']);

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

  // Entry names are hex text; the bytes it spells use a 1/2/3-byte scheme.
  function decodeName(hexText) {
    const b = [];
    for (let i = 0; i < hexText.length; i += 2) b.push(parseInt(hexText.substr(i, 2), 16));
    if (b.some(Number.isNaN)) throw new Error(`파일명이 hex 형식이 아님: ${hexText.slice(0, 40)}`);
    let out = '';
    for (let i = 0; i < b.length;) {
      if (b[i] === 0xff) { out += String.fromCharCode(b[i + 1] << 8 | b[i + 2]); i += 3; }
      else if (b[i] < 0x80) { out += String.fromCharCode(b[i]); i += 1; }
      else { out += String.fromCharCode(b[i] << 8 | b[i + 1]); i += 2; }
    }
    return out;
  }

  // Header says "stored", but the stored bytes are normally a zlib stream.
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unpack(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const entries = new Map();
    Log.info(`머리말 16바이트: ${hex(u8.subarray(0, 16))}`);
    let off = 16;
    if (!(u8[off + 2] === 3 && u8[off + 3] === 4)) {
      // Not where the sample had it: look for the first local header instead.
      const at = u8.findIndex((b, i) => i + 3 < u8.length && (b === 0x55 || b === 0x50) && u8[i + 1] === (b === 0x55 ? 0x43 : 0x4b) && u8[i + 2] === 3 && u8[i + 3] === 4);
      if (at < 0) throw new Error(`엔트리 헤더(UC/PK 03 04)를 찾지 못했습니다. 앞 32바이트: ${hex(u8.subarray(0, 32))}`);
      Log.warn(`첫 엔트리가 16바이트 위치가 아니라 ${at}바이트 위치에 있음`);
      off = at;
    }
    let n = 0;
    while (off + 30 <= u8.length && u8[off + 2] === 3 && u8[off + 3] === 4) {
      const sig = String.fromCharCode(u8[off], u8[off + 1]);
      const method = dv.getUint16(off + 8, true);
      const crc = dv.getUint32(off + 14, true);
      const csize = dv.getUint32(off + 18, true);
      const nlen = dv.getUint16(off + 26, true);
      const elen = dv.getUint16(off + 28, true);
      const start = off + 30 + nlen + elen;
      const rawName = new TextDecoder('ascii').decode(u8.subarray(off + 30, off + 30 + nlen));
      n++;
      let name = rawName;
      try {
        name = decodeName(rawName);
        if (start + csize > u8.length) throw new Error(`데이터가 파일 끝을 넘어감 (필요 ${start + csize}, 파일 ${u8.length})`);
        const blob = u8.subarray(start, start + csize);
        if (crc32(blob) !== crc) Log.warn(`#${n} ${name}: CRC 불일치 (기록 ${crc.toString(16)}, 실제 ${crc32(blob).toString(16)})`);
        let data;
        try {
          data = await inflate(blob);
        } catch {
          data = blob; // genuinely stored
          Log.warn(`#${n} ${name}: zlib 해제 실패 → 압축 안 된 데이터로 간주 (method=${method})`);
        }
        entries.set(name, data);
        Log.ok(`#${n} ${name} (${sig} 헤더, ${kb(csize)} → ${kb(data.length)})`);
      } catch (e) {
        Log.error(`#${n} 엔트리(오프셋 ${off}, 이름 ${name}) 읽기 실패: ${e.message}`);
      }
      off = start + csize;
    }
    const tail = String.fromCharCode(...u8.subarray(off, off + 4).filter((b) => b >= 32 && b < 127));
    if (u8[off] === 0x50 && u8[off + 1] === 0x4b && u8[off + 2] === 1 && u8[off + 3] === 2) {
      Log.ok(`엔트리 ${n}개 읽음, 이어서 중앙 디렉터리 확인 (오프셋 ${off})`);
      const eocd = u8.length - 22;
      if (eocd > 0 && dv.getUint32(eocd, true) === 0x06054b50) {
        const total = dv.getUint16(eocd + 10, true);
        if (total !== n) Log.warn(`목차상 엔트리 ${total}개, 실제 읽은 엔트리 ${n}개`);
        else Log.ok(`목차 엔트리 수 일치 (${total}개)`);
      }
    } else if (off < u8.length) {
      Log.warn(`엔트리 ${n}개 뒤 알 수 없는 데이터 (오프셋 ${off}, ${u8.length - off}바이트): ${hex(u8.subarray(off, off + 16))} ${tail}`);
    }
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
      const at = (k) => o.getAttribute(k);
      resources[at('id')] = {
        type: at('type'),
        advtype: at('advtype') || '',
        file: o.querySelector('file')?.getAttribute('name') ?? null,
      };
      if (at('advtype') === 'input') {
        resources[at('id')].input = {
          background: at('background'), opacity: num(at('opacity')), border: num(at('border')),
          bordercolor: at('bordercolor'), radius: num(at('radius')),
          btncolor: at('btncolor'), btnbackground: at('btnbackground'), btnopacity: num(at('btnopacity')),
        };
      }
    }
    const byType = {};
    for (const r of Object.values(resources)) byType[r.type] = (byType[r.type] || 0) + 1;
    Log.ok(`리소스 ${Object.keys(resources).length}개: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);

    const texts = {};
    for (const n of doc.querySelectorAll('global > scenario > node')) texts[n.getAttribute('id')] = n.textContent;
    Log.ok(`대사/서술 텍스트 ${Object.keys(texts).length}개`);

    const script = parseScript(doc.querySelector('global > script')?.textContent ?? '');

    const scenes = doc.querySelectorAll('content > scene');
    if (!scenes.length) throw new Error('<content><scene>이 없습니다.');
    if (scenes.length > 1) Log.warn(`장면(scene)이 ${scenes.length}개 — 첫 장면 "${scenes[0].getAttribute('id')}"만 재생`);
    const scene = scenes[0];
    const total = num(scene.getAttribute('page'));
    Log.ok(`장면 "${scene.getAttribute('id')}": ${total}장`);
    const pages = [];
    for (let p = 1; p <= total; p++) pages.push({ page: p, advance: { mode: 'click' }, background: null, images: [], inputs: [], text: null, bgm: null });

    const unknown = new Map();
    const note = (what) => unknown.set(what, (unknown.get(what) || 0) + 1);
    let order = 0;
    for (const el of scene.children) {
      if (el.tagName === 'delay') {
        const pg = pages[num(el.getAttribute('page')) - 1];
        if (!pg) { note(`범위 밖 delay(page=${el.getAttribute('page')})`); continue; }
        // mode "scen": wait for the reader's click; "button": wait for an input box to be submitted;
        // mode "": advance after `time` ms.
        const mode = el.getAttribute('mode');
        if (mode === 'scen') pg.advance = { mode: 'click' };
        else if (mode === 'button') pg.advance = { mode: 'input' };
        else {
          if (mode) note(`delay mode="${mode}" (자동 넘김으로 처리)`);
          pg.advance = { mode: 'auto', ms: num(el.getAttribute('time')) };
        }
        continue;
      }
      if (el.tagName !== 'folder') { note(`<${el.tagName}>`); continue; }
      for (const layer of el.querySelectorAll(':scope > layer')) {
        const kind = layer.getAttribute('type');
        if (!KNOWN_LAYERS.has(kind)) note(`레이어 type="${kind}"`);
        for (const n of layer.querySelectorAll(':scope > node')) {
          order++;
          const a = (k) => n.getAttribute(k);
          if (kind === 'scenario') {
            const pg = pages[num(a('page')) - 1];
            if (!pg) { note(`범위 밖 텍스트(page=${a('page')})`); continue; }
            if (!(a('ref') in texts)) note(`없는 텍스트 ref="${a('ref')}"`);
            if (pg.text) note('한 장에 텍스트 2개 이상 (마지막 것만 표시)');
            pg.text = {
              text: texts[a('ref')] ?? '', x: num(a('x')), y: num(a('y')),
              width: num(a('width')), height: num(a('height')), align: a('align') || 'center',
              color: a('color') || 'ffffff', outline: a('outlinecolor'), outlineAlpha: num(a('outlineAlpha')),
              vPadding: num(a('vPadding')), hPadding: num(a('hPadding')), leading: num(a('leading')),
              speed: num(a('speed')),
              // Text window: fill colour + opacity (0..100), border and corner radius, as UCScenario draws it.
              bg: a('background') || '0', bgOpacity: num(a('opacity')),
              border: num(a('border')), bordercolor: a('bordercolor') || 'ffffff', radius: num(a('radius')),
            };
            continue;
          }
          const ref = a('ref');
          const res = resources[ref];
          if (!res && kind !== 'effect' && kind !== 'group') note(`없는 리소스 ref="${ref}"`);
          const start = num(a('start')), end = num(a('end'));
          let item;
          if (kind === 'bgm') {
            item = { key: a('id'), ref, file: res?.file, start, end };
          } else if (kind === 'image' && res?.advtype === 'input') {
            // An input box component; its picture is only the editor's placeholder.
            item = {
              key: a('id'), id: a('id'), ref, start, end, style: res.input,
              x: num(a('x')), y: num(a('y')), width: num(a('width')), height: num(a('height')),
              handler: script.onInput[a('id')] ?? null,
            };
            for (let p = Math.max(start, 1); p <= Math.min(end, total); p++) pages[p - 1].inputs.push(item);
            continue;
          } else if (kind === 'back' || kind === 'image') {
            if (a('hidden') === 'true') continue;
            item = {
              key: a('id') || `n${order}`, ref, file: res?.file && base(res.file), start, end,
              x: num(a('x')), y: num(a('y')), width: num(a('width')), height: num(a('height')),
              z: num(a('z')), order, effects: effects(n),
            };
          } else {
            note(`${kind} 레이어의 노드 (미지원)`);
            continue;
          }
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
    for (const [what, count] of unknown) Log.warn(`처리하지 않은 항목: ${what} ×${count}`);

    const tags = new Map();
    for (const pg of pages) {
      for (const m of (pg.text?.text ?? '').matchAll(/([#$])([^;#$\s]{1,30});/g)) {
        const key = m[1] + m[2].split('.')[0] + ';';
        tags.set(key, (tags.get(key) || 0) + 1);
      }
    }
    if (tags.size) Log.info(`텍스트 태그 사용: ${[...tags].map(([k, v]) => `${k}×${v}`).join(', ')}`);
    for (const k of tags.keys()) {
      if (k[0] === '$') {
        if (!(k.slice(1, -1).replace(/\[\d+\]$/, '') in script.vars)) Log.warn(`변수 ${k} 사용 — 선언된 스크립트 변수가 없어 빈칸으로 표시됨`);
      } else if (!['#w;', '#c;', '#d;'].includes(k)) Log.warn(`태그 ${k} — 스크립트 호출이라 무시됨`);
    }

    const inputs = pages.reduce((n, p) => n + p.inputs.length, 0);
    if (inputs) Log.ok(`입력창 ${inputs}개 (${pages.filter((p) => p.inputs.length).map((p) => `${p.page}장`).join(', ')})`);
    const autoPages = pages.filter((p) => p.advance.mode === 'auto').length;
    Log.ok(`타임라인 완성: 텍스트 ${pages.filter((p) => p.text).length}장, 자동 넘김 ${autoPages}장, BGM 구간 ${new Set(pages.map((p) => p.bgm?.key).filter(Boolean)).size}개`);

    return {
      width: num(opt('size', 'width'), 800),
      height: num(opt('size', 'height'), 480),
      font: opt('font', 'Fontname'),
      fontSize: num(opt('fontsize', 'Fontsize'), 15),
      resources,
      texts,
      vars: script.vars,
      pages,
    };
  }

  // A small subset of UCscript, enough for name input: global variable declarations and
  // `void onInput[nodeId](string v) { 변수 = v; gotoPageNext(); }` handlers. Anything else is logged.
  function parseScript(src) {
    const out = { vars: {}, onInput: {} };
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    if (!code || /^;*$/.test(code)) return out;
    const NAME = '[^\\s;=(){}\\[\\],]+';
    const unsupported = [];
    const top = code.replace(new RegExp(`void\\s+(${NAME})(\\[[^\\]]*\\])?\\s*\\(([^)]*)\\)\\s*\\{([^{}]*)\\}`, 'g'), (all, fn, idx, params, body) => {
      const m = /^\[(\d+)\]$/.exec(idx || '');
      const param = params.trim().split(/\s+/).pop();
      if (fn !== 'onInput' || !m || !param) { unsupported.push(`함수 ${fn}${idx || ''}`); return ''; }
      const steps = [];
      for (const st of body.split(';').map((x) => x.trim()).filter(Boolean)) {
        const set = new RegExp(`^(${NAME})\\s*=\\s*${param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).exec(st);
        if (set) steps.push({ op: 'set', name: set[1] });
        else if (/^gotoPageNext\(\s*\)$/.test(st)) steps.push({ op: 'next' });
        else if (/^gotoPagePrev\(\s*\)$/.test(st)) steps.push({ op: 'prev' });
        else unsupported.push(`문장 "${st.slice(0, 40)}"`);
      }
      out.onInput[m[1]] = steps;
      return '';
    });
    for (const st of top.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = new RegExp(`^(string|int|double|bool|boolean)\\s+(${NAME})\\s*(?:=\\s*(.+))?$`).exec(st);
      if (m) out.vars[m[2]] = m[3] ? m[3].trim().replace(/^"(.*)"$/, '$1') : '';
      else unsupported.push(`문장 "${st.slice(0, 40)}"`);
    }
    Log.ok(`작품 스크립트: 변수 ${Object.keys(out.vars).length}개(${Object.keys(out.vars).join(', ') || '-'}), 입력 처리 ${Object.keys(out.onInput).length}개`);
    if (unsupported.length) Log.warn(`작품 스크립트 중 지원하지 않는 부분 ${unsupported.length}개 — 동작하지 않음: ${unsupported.slice(0, 5).join(', ')}${unsupported.length > 5 ? ' …' : ''}`);
    return out;
  }

  async function load(file) {
    Log.info(`파일 열기: ${file.name} (${(file.size / 1048576).toFixed(2)}MB)`);
    const t0 = performance.now();
    const entries = await unpack(await file.arrayBuffer());
    const xmlBytes = entries.get('script.xml');
    if (!xmlBytes) throw new Error('script.xml을 찾을 수 없습니다. .ucn 파일이 맞나요?');
    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error(`script.xml 해석 실패: ${err.textContent.trim().slice(0, 200)}`);
    Log.ok(`script.xml 해석 성공 (${kb(xmlBytes.length)}, 작성자 ${doc.documentElement.getAttribute('owner') || '알 수 없음'})`);

    const story = buildStory(doc);
    const files = new Map();
    for (const [name, data] of entries) {
      if (name === 'script.xml') continue;
      const ext = name.split('.').pop().toLowerCase();
      if (!MIME[ext]) Log.warn(`이미지가 아닌 파일: ${name}`);
      files.set(base(name), { name, data, url: URL.createObjectURL(new Blob([data], { type: MIME[ext] || 'application/octet-stream' })) });
    }
    const referenced = new Set(Object.values(story.resources).filter((r) => r.type !== 'bgm' && r.file).map((r) => base(r.file)));
    const missing = [...referenced].filter((f) => !files.has(f));
    if (missing.length) Log.error(`리소스에 있지만 파일에 없는 이미지 ${missing.length}개: ${missing.join(', ')}`);
    else Log.ok(`참조된 이미지 ${referenced.size}개 모두 있음`);
    Log.ok(`불러오기 완료 (${Math.round(performance.now() - t0)}ms)`);
    return { story, files, urls: new Map([...files].map(([k, v]) => [k, v.url])) };
  }

  return { load, crc32 };
})();
