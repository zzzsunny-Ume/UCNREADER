// Reads a .ucn file in the browser: unpacks the archive and builds the
// per-page timeline. Mirrors tools/ucn_extract.py; see docs/UCN_FORMAT.md.
// Every step reports to Log so readers can send the log when a file fails.
const UCN = (() => {
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', mp3: 'audio/mpeg' };
  const COMPONENT = { button: '버튼', timer: '타이머', text: '텍스트', graph: '그래프', sprite: '스프라이트', video: '동영상', animation: '애니메이션' };
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
      const a = (k) => e.getAttribute(k);
      const n = (k) => { const v = parseInt(a(k), 10); return Number.isNaN(v) ? null : v; };
      // x/y: offset the move starts from (enter) or goes to (exit), negated as in the original;
      // width/height: % for images, stage pixels for backgrounds; option: easing or shake.
      fx[a('type')] = {
        effect: a('effect'), time: num(a('time')),
        x: n('x') ?? 0, y: n('y') ?? 0, width: n('width'), height: n('height'),
        rotation: n('rotation') ?? 0, option: a('option') || 'none',
      };
    }
    return fx;
  }

  function buildStory(doc) {
    const opt = (p, a) => doc.querySelector(`system > option[parameter="${p}"]`)?.getAttribute(a);
    const stageW = num(opt('size', 'width'), 800), stageH = num(opt('size', 'height'), 480);
    const unknown = new Map();
    const note = (what) => unknown.set(what, (unknown.get(what) || 0) + 1);
    const resources = {};
    for (const o of doc.querySelectorAll('global > resource object')) {
      const at = (k) => o.getAttribute(k);
      resources[at('id')] = {
        type: at('type'),
        advtype: at('advtype') || '',
        file: o.querySelector('file')?.getAttribute('name') ?? null,
      };
      if (at('advtype') === 'timer') {
        resources[at('id')].timer = {
          maxtime: num(at('maxtime'), 10), color: at('color') || 'ffffff',
          outlinecolor: at('outlinecolor') || '000000', outlineAlpha: num(at('outlineAlpha'), 100),
          background: at('background'), opacity: num(at('opacity')), radius: num(at('radius')),
          border: num(at('border')), bordercolor: at('bordercolor'),
        };
      }
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
    for (let p = 1; p <= total; p++) pages.push({ page: p, advance: { mode: 'click' }, background: null, images: [], inputs: [], timers: [], text: null, bgm: null, notes: [] });

    let order = 0;
    const components = [];
    for (const el of scene.children) {
      if (el.tagName === 'delay') {
        const pg = pages[num(el.getAttribute('page')) - 1];
        if (!pg) { note(`범위 밖 delay(page=${el.getAttribute('page')})`); continue; }
        // mode "scen": wait for the reader's click; "button": wait for an input box to be submitted;
        // mode "": advance after `time` ms.
        const mode = el.getAttribute('mode');
        if (el.getAttribute('bgm') === 'true' || el.getAttribute('effect') === 'true') note('장 넘김의 bgm/effect 옵션 (미반영)');
        if (mode === 'scen') pg.advance = { mode: 'click' };
        // "button": wait for the page's interactive component (input box, timer, …);
        // "click": a page without text that waits for a tap (UCPlayer.loadPage).
        else if (mode === 'button') pg.advance = { mode: 'input' };
        else if (mode === 'click') pg.advance = { mode: 'click' };
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
            // Text attributes the player doesn't draw yet: flag them when they differ from the defaults.
            if (a('backgroundimage')) note('글창 배경 그림 backgroundimage (미반영)');
            if (num(a('gRotation')) || num(a('gHeight'))) note('텍스트 그라데이션 gRotation/gHeight (미반영)');
            if (['para', 'page', 'auto'].includes(a('event'))) note(`텍스트 넘김 방식 event="${a('event')}" (미반영)`);
            if (a('type')) note(`텍스트 type="${a('type')}" (미반영)`);
            if (a('invert') === 'true') note('텍스트 invert (미반영)');
            pg.text = {
              text: texts[a('ref')] ?? '', x: num(a('x')), y: num(a('y')),
              width: num(a('width')), height: num(a('height')), align: a('align') || 'center',
              color: a('color') || 'ffffff', outline: a('outlinecolor'), outlineAlpha: num(a('outlineAlpha')),
              vPadding: num(a('vPadding')), hPadding: num(a('hPadding')), leading: num(a('leading')),
              // Stored on a 0..9 scale; the original player uses speed / 9 × 100 (9 = whole line at once).
              speed: Math.round(num(a('speed')) / 9 * 100),
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
          } else if (kind === 'image' && res?.advtype === 'timer') {
            // Countdown component: draws the remaining seconds; its picture is the editor's placeholder.
            item = {
              key: a('id'), id: a('id'), ref, start, end, style: res.timer, hidden: a('hidden') === 'true',
              x: num(a('x')), y: num(a('y')), width: num(a('width')), height: num(a('height')),
              onStart: script.onTimerStart[a('id')] ?? null, onFinish: script.onTimerFinish[a('id')] ?? null,
            };
            for (let p = Math.max(start, 1); p <= Math.min(end, total); p++) pages[p - 1].timers.push(item);
            continue;
          } else if (kind === 'image' && res?.advtype) {
            // Another component (button, timer, …): not supported yet. Show its picture, say where it is.
            const label = `${COMPONENT[res.advtype] || res.advtype} 부품 "${ref}"`;
            components.push(`${label} (노드 ${a('id')}, ${start}~${end}장)`);
            for (let p = Math.max(start, 1); p <= Math.min(end, total); p++) pages[p - 1].notes.push(`${label} 미지원 — 그림만 표시`);
            item = {
              key: a('id') || `n${order}`, ref, file: res.file && base(res.file), start, end,
              x: num(a('x')), y: num(a('y')), width: num(a('width')), height: num(a('height')),
              z: num(a('z')), order, effects: effects(n),
            };
          } else if (kind === 'back' || kind === 'image') {
            if (a('hidden') === 'true') continue;
            if (a('invert') === 'true') note('이미지 invert (미반영)');
            for (const e of n.querySelectorAll(':scope > effect')) {
              const ea = (k) => e.getAttribute(k);
              if (ea('effect') === 'none' || !num(ea('time'))) continue; // the original skips these entirely
              if (!['none', 'accel', 'decel', 'over', 'hquake', 'vquake', null, ''].includes(ea('option'))) note(`효과 옵션 ${ea('option')} (미지원)`);
            }
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

    if (components.length) Log.warn(`지원하지 않는 부품 ${components.length}개 — 그 장에서 원래 동작(버튼 누르기, 시간 제한 등)을 하지 않음: ${components.join(', ')}`);
    // A page that waits for something we can't show (a button, a timer, …) would stop the story:
    // move on to the next page instead — on its own if there is nothing to read, else on a click.
    const stuck = pages.filter((p) => p.advance.mode === 'input' && !p.inputs.length && !p.timers.length);
    for (const p of stuck) {
      p.notes.push('부품 입력을 기다리는 장(delay mode="button")이지만 지원하는 부품이 없어 다음 장으로 넘김');
      p.advance = p.text ? { mode: 'click' } : { mode: 'auto', ms: 1000 };
    }
    if (stuck.length) Log.error(`멈출 수 있는 장 ${stuck.length}개 (${stuck.map((p) => `${p.page}장`).join(', ')}): 원래는 버튼·타이머 등 부품 입력을 기다리는 장 — 다음 장으로 넘어가도록 대체함`);
    const inputs = pages.reduce((n, p) => n + p.inputs.length, 0);
    const timers = pages.filter((p) => p.timers.length);
    if (timers.length) Log.ok(`타이머 ${timers.map((p) => `${p.page}장(${p.timers.map((t) => `${t.style.maxtime}초`).join(', ')})`).join(', ')}`);
    if (inputs) Log.ok(`입력창 ${inputs}개 (${pages.filter((p) => p.inputs.length).map((p) => `${p.page}장`).join(', ')})`);
    const autoPages = pages.filter((p) => p.advance.mode === 'auto').length;
    Log.ok(`타임라인 완성: 텍스트 ${pages.filter((p) => p.text).length}장, 자동 넘김 ${autoPages}장, BGM 구간 ${new Set(pages.map((p) => p.bgm?.key).filter(Boolean)).size}개`);

    return {
      width: stageW,
      height: stageH,
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
    const out = { vars: {}, onInput: {}, onTimerStart: {}, onTimerFinish: {}, onClick: {} };
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    if (!code || /^;*$/.test(code)) return out;
    const NAME = '[^\\s;=(){}\\[\\],]+';
    const unsupported = [];
    const top = code.replace(new RegExp(`void\\s+(${NAME})(\\[[^\\]]*\\])?\\s*\\(([^)]*)\\)\\s*\\{([^{}]*)\\}`, 'g'), (all, fn, idx, params, body) => {
      const m = /^\[(\d+)\]$/.exec(idx || '');
      const param = params.trim() ? params.trim().split(/\s+/).pop() : '';
      // Component events: onInput[id](string v), onTimerStart[id](), onTimerFinish[id](), onClick[id]().
      if (!(fn in out) || fn === 'vars' || !m || (fn === 'onInput' && !param)) { unsupported.push(`함수 ${fn}${idx || ''}`); return ''; }
      const steps = [];
      for (const st of body.split(';').map((x) => x.trim()).filter(Boolean)) {
        const set = param && new RegExp(`^(${NAME})\\s*=\\s*${param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).exec(st);
        if (set) steps.push({ op: 'set', name: set[1] });
        else if (/^gotoPageNext\(\s*\)$/.test(st)) steps.push({ op: 'next' });
        else if (/^gotoPagePrev\(\s*\)$/.test(st)) steps.push({ op: 'prev' });
        else unsupported.push(`문장 "${st.slice(0, 40)}"`);
      }
      out[fn][m[1]] = steps;
      return '';
    });
    for (const st of top.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = new RegExp(`^(string|int|double|bool|boolean)\\s+(${NAME})\\s*(?:=\\s*(.+))?$`).exec(st);
      if (m) out.vars[m[2]] = m[3] ? m[3].trim().replace(/^"(.*)"$/, '$1') : '';
      else unsupported.push(`문장 "${st.slice(0, 40)}"`);
    }
    const events = ['onInput', 'onTimerStart', 'onTimerFinish', 'onClick'].map((k) => [k, Object.keys(out[k]).length]).filter(([, n]) => n);
    Log.ok(`작품 스크립트: 변수 ${Object.keys(out.vars).length}개(${Object.keys(out.vars).join(', ') || '-'}), 처리 함수 ${events.map(([k, n]) => `${k} ${n}개`).join(', ') || '없음'}`);
    if (unsupported.length) Log.warn(`작품 스크립트 중 지원하지 않는 부분 ${unsupported.length}개 — 동작하지 않음: ${unsupported.slice(0, 12).join(', ')}${unsupported.length > 12 ? ` 외 ${unsupported.length - 12}개` : ''}`);
    return out;
  }

  // ---- old studio format (.ucn v1) -------------------------------------------------
  // 16-byte header (2, entry count, 0, 1), then one 1072-byte index record per entry, XOR 0x47:
  // u32 offset, u32 size, u32 offset again, u32 type (15), 12 zero bytes, CP949 file name (0xCD padded).
  // File data follows the index unchanged; music is stored inside as mp3.
  const OLD_RECORD = 1072;

  function isOldFormat(u8) {
    if (u8.length < 16 + OLD_RECORD) return false;
    const dv = new DataView(u8.buffer, u8.byteOffset);
    const n = dv.getUint32(4, true);
    return dv.getUint32(0, true) === 2 && dv.getUint32(12, true) === 1 && n > 0 && 16 + n * OLD_RECORD < u8.length
      && (u8[16 + 28] ^ 0x47) >= 0x20; // first file name starts with a printable byte
  }

  function unpackOld(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    const n = dv.getUint32(4, true);
    const base = 16 + n * OLD_RECORD;
    const cp949 = new TextDecoder('euc-kr');
    const entries = new Map();
    Log.ok(`옛 스튜디오 형식(.ucn v1): 엔트리 ${n}개, 목차 XOR 0x47`);
    let thumbs = 0;
    for (let i = 0; i < n; i++) {
      const rec = u8.slice(16 + i * OLD_RECORD, 16 + (i + 1) * OLD_RECORD).map((b) => b ^ 0x47);
      const rv = new DataView(rec.buffer);
      const off = rv.getUint32(0, true), size = rv.getUint32(4, true);
      const end = rec.indexOf(0, 28);
      const name = cp949.decode(rec.subarray(28, end < 0 ? rec.length : end));
      if (base + off + size > u8.length) { Log.error(`#${i + 1} ${name}: 데이터가 파일 끝을 넘어감`); continue; }
      if (name.endsWith('_th')) { thumbs++; continue; } // editor thumbnails
      entries.set(name, u8.subarray(base + off, base + off + size));
    }
    const kinds = {};
    for (const name of entries.keys()) { const e = name.split('.').pop().toLowerCase(); kinds[e] = (kinds[e] || 0) + 1; }
    Log.ok(`옛 형식 파일 ${entries.size}개 읽음 (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}), 썸네일 ${thumbs}개 제외`);
    return entries;
  }

  // Everything seen in the old-format samples (Onpair p.01–03). Anything else is logged with its pages,
  // because how the old studio meant it is unknown: key = "parent>tag", a = attributes, c = children,
  // v = known values per attribute. Effect names also accept every mask transition.
  const OLD_EFFECTS = ['fade', 'none', 'reserved'];
  const OLD_SCHEMA = {
    'ucscript': { c: ['global', 'folder', 'object', 'character', 'scene'] },
    'ucscript>global': { c: ['font', 'color', 'option', 'var'] },
    'global>font': { c: ['node'] }, 'font>node': { a: ['id', 'size', 'name'] },
    'global>color': { c: ['node'] }, 'color>node': { a: ['id', 'color'] },
    'global>option': { c: ['text'] }, 'option>text': { a: ['event', 'speed'] },
    'global>var': { c: ['node'] }, 'var>node': { a: ['name', 'type', 'data'], v: { type: ['timer', 'string'] } },
    'ucscript>folder': { c: ['node'] }, 'folder>node': { a: ['name'] },
    'ucscript>object': { c: ['node'] },
    // ex="input"/"timer" objects (folder 고급자원) are components with bgcolor/alpha/color/title/text/time.
    'object>node': { a: ['name', 'type', 'category', 'folder', 'pack', 'play', 'width', 'height', 'frame', 'page', 'ex', 'bgcolor', 'alpha', 'color', 'title', 'text', 'time'], c: ['frame'],
      v: { type: ['image', 'sound'], category: ['bg', 'image', 'bgm'], frame: ['1'], play: ['0'], page: ['1'], ex: ['0', 'input', 'timer'], pack: ['user'] } },
    'node>frame': { a: ['type', 'load', 'play', 'delay'], v: { type: ['single'], play: ['0'], delay: ['1'] } },
    'ucscript>character': { a: ['skin', 'ix', 'iy', 'idx', 'idy', 'nx', 'ny', 'ndx', 'ndy', 'nalign'] },
    'ucscript>scene': { c: ['node'] }, 'scene>node': { a: ['name'], c: ['layer', 'inst'] },
    'node>layer': { c: ['layer'] }, 'layer>layer': { a: ['name', 'object'] },
    'node>inst': { c: ['global', 'page'] }, 'inst>global': {},
    'inst>page': { a: ['id'], c: ['bgm', 'sound', 'background', 'image', 'content'] },
    'page>bgm': { a: ['name', 'count'] }, 'page>sound': { a: ['name'] },
    'page>background': { a: ['fadein', 'fadeout', 'name', 'time'], v: { fadein: 'effect', fadeout: 'effect' } },
    'page>image': { a: ['name', 'fadein', 'fadeout', 'time', 'x', 'y', 'width', 'height', 'multi', 'type'], c: ['button'],
      v: { type: ['', 'input', 'timer'], multi: ['0'], fadein: 'effect', fadeout: 'effect' } },
    'image>button': { c: ['goto', 'var'] }, 'button>goto': { a: ['scene', 'page'], v: { scene: ['다음 쪽', '이전 쪽'], page: ['1'] } },
    'button>var': { a: ['name'] },
    'page>content': { a: ['multi', 'x', 'y', 'width', 'height', 'line', 'align', 'alpha', 'color', 'head', 'speed', 'event'], c: ['text'],
      v: { multi: ['0'], align: ['center', 'left', 'right'], head: ['0'], event: ['2'] } },
    'content>text': { a: ['data'] },
  };

  function checkOldSchema(doc) {
    const seen = new Map(); // message -> Set of page numbers (0 = outside pages)
    const add = (msg, page) => { if (!seen.has(msg)) seen.set(msg, new Set()); seen.get(msg).add(page); };
    const known = (val, rule) => rule === 'effect'
      ? OLD_EFFECTS.includes(val) || (typeof UC_MASKS !== 'undefined' && val in UC_MASKS)
      : rule.includes(val);
    // owner: the named object/layer the element belongs to, so global findings say where they are.
    const walk = (el, parentTag, page, owner) => {
      const key = parentTag ? `${parentTag}>${el.tagName}` : el.tagName;
      const spec = OLD_SCHEMA[key];
      if (el.tagName === 'page') page = num(el.getAttribute('id'), -1) + 1;
      if (!page && el.getAttribute('name')) owner = `${parentTag || el.tagName} "${el.getAttribute('name')}"`;
      const at = owner && !page ? ` [${owner}]` : '';
      if (!spec) { add(`처음 보는 요소 <${parentTag}>/<${el.tagName}> (속성: ${[...el.attributes].map((x) => `${x.name}="${x.value.slice(0, 20)}"`).join(' ') || '없음'})${at}`, page); return; }
      for (const a of el.attributes) {
        if (!(spec.a || []).includes(a.name)) add(`처음 보는 속성 <${el.tagName} ${a.name}="${a.value.slice(0, 30)}">${at}`, page);
        else if (spec.v?.[a.name] && !known(a.value, spec.v[a.name])) add(`처음 보는 값 <${el.tagName} ${a.name}="${a.value.slice(0, 30)}">${at}`, page);
      }
      for (const c of el.children) {
        if (!(spec.c || []).includes(c.tagName) && OLD_SCHEMA[`${el.tagName}>${c.tagName}`] === undefined) {
          add(`처음 보는 요소 <${el.tagName}>/<${c.tagName}> (속성: ${[...c.attributes].map((x) => `${x.name}="${x.value.slice(0, 20)}"`).join(' ') || '없음'})${at}`, page);
        } else walk(c, el.tagName, page, owner);
      }
    };
    walk(doc.documentElement, '', 0, '');
    if (!seen.size) { Log.ok('옛 형식 구조 검사: 모든 요소·속성·값이 알려진 형식'); return; }
    Log.warn(`옛 형식 구조 검사: 처음 보는 항목 ${seen.size}종 — 원래 어떻게 보였는지 몰라 무시하거나 추정으로 처리함. 아래 목록을 제보해 주세요`);
    for (const [msg, pages] of seen) {
      const ps = [...pages].filter((p) => p > 0).sort((a, b) => a - b);
      const where = ps.length ? `${ps.length}개 장: ${ps.slice(0, 12).map((p) => `${p}장`).join(', ')}${ps.length > 12 ? ' …' : ''}` : '장 밖(전역 설정)';
      Log.warn(`  ${msg} — ${where}`);
    }
  }

  // Turns the old page-event script (<scene><node><inst><page>…) into the same timeline as buildStory.
  // Old pages record changes: a background/image fades in or out on a page and stays until it fades out.
  function buildOldStory(doc) {
    const W = 640, H = 480;
    const q = (sel) => doc.querySelector(sel);
    const objects = {};
    for (const o of doc.querySelectorAll(':scope > object > node')) {
      const at = (k) => o.getAttribute(k);
      objects[at('name')] = {
        type: at('type'), category: at('category'), ex: at('ex'),
        file: o.querySelector('frame')?.getAttribute('load') ?? null,
        // component settings (ex="input"/"timer")
        bgcolor: (at('bgcolor') || '0x0').replace(/^0x/i, '').padStart(6, '0'), alpha: num(at('alpha')),
        color: (at('color') || '0xffffff').replace(/^0x/i, '').padStart(6, '0'),
        title: at('title') || '', text: at('text') || '', time: at('time') != null ? num(at('time'), 5) : null,
      };
    }
    const layers = {};
    for (const l of doc.querySelectorAll(':scope > scene > node > layer > layer')) layers[l.getAttribute('name')] = l.getAttribute('object');
    const obj = (layerName) => objects[layers[layerName] ?? layerName] ?? null;

    const vars = {};
    let timerSeconds = 5;
    for (const v of doc.querySelectorAll(':scope > global > var > node')) {
      const name = (v.getAttribute('name') || '').replace(/^\$/, '');
      if (v.getAttribute('type') === 'timer') timerSeconds = num(v.getAttribute('data'), 5);
      else vars[name] = v.getAttribute('data') || '';
    }
    const fontNode = q(':scope > global > font > node');
    const fontSize = Math.max(num(fontNode?.getAttribute('size'), 12), 14);

    checkOldSchema(doc);
    const pageEls = [...doc.querySelectorAll(':scope > scene > node > inst > page')];
    const total = pageEls.length;
    const scenes = doc.querySelectorAll(':scope > scene > node').length;
    if (scenes > 1) Log.warn(`옛 형식 장면이 ${scenes}개 — 첫 장면만 재생`);
    Log.ok(`옛 형식 장면 "${q(':scope > scene > node')?.getAttribute('name') ?? ''}": ${total}장, 오브젝트 ${Object.keys(objects).length}개`);

    const pages = [];
    for (let p = 1; p <= total; p++) pages.push({ page: p, advance: { mode: 'click' }, background: null, images: [], inputs: [], timers: [], text: null, bgm: null, notes: [], infos: [] });
    const unknown = new Map();
    const note = (what) => unknown.set(what, (unknown.get(what) || 0) + 1);
    const fx = (e, which) => {
      const name = e.getAttribute(which);
      // "reserved": no exit effect; the picture stays under the next one as it fades in.
      return { effect: !name || name === 'reserved' ? 'none' : name, time: num(e.getAttribute('time')), x: 0, y: 0, width: null, height: null, rotation: 0, option: 'none' };
    };
    const steps = (img) => {
      const out = [];
      const v = img.querySelector('button > var')?.getAttribute('name');
      if (v) out.push({ op: 'set', name: v.replace(/^\$/, '') });
      const g = img.querySelector('button > goto');
      if (g) {
        const scene = g.getAttribute('scene');
        if (scene === '다음 쪽') out.push({ op: 'next' });
        else if (scene === '이전 쪽') out.push({ op: 'prev' });
        else { note(`버튼 이동 대상 "${scene}" (다음 장으로 대체)`); out.push({ op: 'next' }); }
      }
      return out;
    };

    let order = 0, bg = null;
    const items = [];
    const live = new Map(); // image layer name -> item
    pageEls.forEach((el, i) => {
      const pg = pages[i];
      const p = i + 1;
      let effectMs = 0;
      for (const c of el.children) {
        const a = (k) => c.getAttribute(k);
        if (c.tagName === 'background') {
          const o = obj(a('name'));
          if (!o) note(`없는 배경 "${a('name')}"`);
          if (a('fadein') != null) {
            if (bg && bg.end === Infinity) bg.end = p - 1;
            bg = { key: `bg${p}`, ref: a('name'), file: o?.file, kind: 'back', start: p, end: Infinity, x: 0, y: 0, width: W, height: H, z: 0, order: ++order,
              effects: { start: fx(c, 'fadein'), end: { effect: 'none', time: 0 } } };
            items.push(bg);
            effectMs = Math.max(effectMs, num(a('time')));
          } else if (a('fadeout') != null && bg) {
            bg.end = p;
            bg.effects.end = fx(c, 'fadeout');
          }
        } else if (c.tagName === 'image') {
          const name = a('name');
          const box = { x: num(a('x')), y: num(a('y')), width: num(a('width')), height: num(a('height')) };
          if (a('fadein') != null) {
            const type = a('type') || '';
            const co = obj(name);
            if (type === 'timer') {
              pg.timers.push({ key: `timer${p}`, id: `timer${p}`, ...box, hidden: false, onStart: null, onFinish: steps(c),
                style: { maxtime: co?.time ?? timerSeconds, color: co?.color ?? 'ffffff', background: co?.bgcolor ?? '0', opacity: co?.alpha ?? 0, radius: 0, border: 0 } });
              if (co?.title) pg.notes.push(`타이머 제목 "${co.title}" 미표시`);
            } else if (type === 'input') {
              pg.inputs.push({ key: `input${p}`, id: `input${p}`, ref: name, ...box, handler: steps(c), title: co?.title || '', initial: co?.text || '',
                style: { background: co?.bgcolor ?? '0', opacity: co?.alpha ?? 0, border: 0, radius: 0, btncolor: co?.color ?? 'ffffff', btnbackground: 'ffffff', btnopacity: 0 } });
            } else {
              if (type) note(`이미지 종류 type="${type}" (그림으로 표시)`);
              const o = obj(name);
              if (!o) note(`없는 이미지 "${name}"`);
              const item = { key: `img${p}-${name}`, ref: name, file: o?.file, kind: 'image', start: p, end: Infinity, ...box, z: order + 1, order: ++order,
                effects: { start: fx(c, 'fadein'), end: { effect: 'none', time: 0 } } };
              live.set(name, item);
              items.push(item);
            }
            effectMs = Math.max(effectMs, num(a('time')));
          } else if (a('fadeout') != null && live.has(name)) {
            const item = live.get(name);
            item.end = p;
            item.effects.end = fx(c, 'fadeout');
            live.delete(name);
          }
        } else if (c.tagName === 'bgm') {
          const o = obj(a('name'));
          if (a('name') && o?.file) pg.bgm = { key: a('name'), ref: layers[a('name')] ?? a('name'), file: o.file, loop: num(a('count'), 1) > 1 };
          else if (a('name')) note(`없는 음악 "${a('name')}"`);
        } else if (c.tagName === 'sound') {
          if (a('name')) note('효과음 sound (미지원)');
        } else if (c.tagName === 'content') {
          const data = c.querySelector('text')?.getAttribute('data') ?? '';
          const h = num(a('height')), lines = Math.max(num(a('line'), 3), 1);
          if (num(a('event')) === 2) pg.autoEvent = true;
          if (data.trim()) {
            pg.text = {
              text: data, x: num(a('x')), y: num(a('y')), width: num(a('width')), height: h, align: a('align') || 'center',
              color: (a('color') || '0xffffff').replace(/^0x/i, '').padStart(6, '0'),
              vPadding: 10, hPadding: 10, leading: Math.max(4, Math.floor((h - 20) / lines) - fontSize),
              speed: 0, bg: '0', bgOpacity: num(a('alpha')), border: 0, bordercolor: 'ffffff', radius: 0,
            };
          }
        } else note(`<${c.tagName}>`);
      }
      // Advance: input/timer pages wait for them; pages with text wait for a click (event 2 moves on
      // after a while); pages without text were the old studio's timed pauses: move on after the effects.
      if (pg.inputs.length || pg.timers.length) pg.advance = { mode: 'input' };
      else if (pg.text) {
        pg.advance = pg.autoEvent ? { mode: 'auto', ms: 3000 } : { mode: 'click' };
        if (pg.autoEvent) pg.infos.push('글 상자 event="2" → 글을 다 보여 준 뒤 3초 후 자동 넘김(추정)');
      } else {
        pg.advance = { mode: 'auto', ms: Math.max(1000, effectMs + 300) };
        pg.infos.push(`글 없는 장 → ${(pg.advance.ms / 1000).toFixed(1)}초 뒤 자동 넘김(추정${pg.autoEvent ? ', event="2"' : ''})`);
      }
      for (const c of el.children) {
        if (c.getAttribute('fadeout') === 'reserved') pg.infos.push(`${c.tagName === 'image' ? '이미지' : '배경'} 퇴장 "reserved" → 효과 없이 다음 그림 아래에 남았다 사라짐(추정)`);
      }
    });
    for (const it of items) {
      if (it.end === Infinity) it.end = total;
      for (let p = it.start; p <= it.end; p++) {
        if (it.kind === 'back') pages[p - 1].background = it;
        else pages[p - 1].images.push(it);
      }
    }
    for (const pg of pages) pg.images.sort((i, j) => i.z - j.z || i.order - j.order);
    for (const [what, count] of unknown) Log.warn(`처리하지 않은 항목: ${what} ×${count}`);
    const tags = new Map();
    for (const pg of pages) {
      for (const m of (pg.text?.text ?? '').matchAll(/([#$])([^;#$\s]{1,30});/g)) {
        const k = m[1] + m[2].split('.')[0] + ';';
        if (!tags.has(k)) tags.set(k, []);
        tags.get(k).push(pg.page);
      }
    }
    if (tags.size) Log.info(`텍스트 태그 사용: ${[...tags].map(([k, v]) => `${k}×${v.length}`).join(', ')}`);
    for (const [k, ps] of tags) {
      const where = ps.slice(0, 8).map((p) => `${p}장`).join(', ') + (ps.length > 8 ? ' …' : '');
      if (k[0] === '$') { if (!(k.slice(1, -1).replace(/\[\d+\]$/, '') in vars)) Log.warn(`선언되지 않은 변수 ${k} — 빈칸으로 표시 (${where})`); }
      else if (!['#w;', '#c;', '#d;'].includes(k)) Log.warn(`처음 보는 텍스트 태그 ${k} — 무시함 (${where})`);
    }
    const blank = pages.filter((p) => !p.text && p.advance.mode === 'auto').length;
    Log.info(`옛 형식 해석 규칙(추정): 글 없는 장 ${blank}개는 효과 시간 뒤 자동 넘김, event=2 장은 3초 뒤 자동, 글창은 검정에 alpha% 불투명도, 글자 크기 ${fontSize}px`);
    const resources = {};
    for (const [name, o] of Object.entries(objects)) resources[name] = { type: o.category === 'bgm' ? 'bgm' : o.category === 'bg' ? 'back' : 'image', file: o.file };
    const texts = {};
    pages.forEach((pg) => { if (pg.text) texts[pg.page] = pg.text.text; });
    Log.ok(`타임라인 완성: 텍스트 ${pages.filter((p) => p.text).length}장, 자동 넘김 ${pages.filter((p) => p.advance.mode === 'auto').length}장, 입력창 ${pages.reduce((n, p) => n + p.inputs.length, 0)}개, 타이머 ${pages.reduce((n, p) => n + p.timers.length, 0)}개, 음악 ${new Set(pages.map((p) => p.bgm?.key).filter(Boolean)).size}곡`);
    return { width: W, height: H, font: fontNode?.getAttribute('name') ?? null, fontSize, resources, texts, vars, pages, format: 'v1' };
  }

  async function load(file) {
    Log.info(`파일 열기: ${file.name} (${(file.size / 1048576).toFixed(2)}MB)`);
    const t0 = performance.now();
    const buf = await file.arrayBuffer();
    const old = isOldFormat(new Uint8Array(buf));
    const entries = old ? unpackOld(buf) : await unpack(buf);
    const xmlBytes = entries.get('script.xml');
    if (!xmlBytes) throw new Error('script.xml을 찾을 수 없습니다. .ucn 파일이 맞나요?');
    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error(`script.xml 해석 실패: ${err.textContent.trim().slice(0, 200)}`);
    Log.ok(`script.xml 해석 성공 (${kb(xmlBytes.length)}, 작성자 ${doc.documentElement.getAttribute('owner') || '알 수 없음'})`);

    const story = old || doc.querySelector(':scope > scene > node > inst') ? buildOldStory(doc) : buildStory(doc);
    const files = new Map();
    for (const [name, data] of entries) {
      if (name === 'script.xml') continue;
      const ext = name.split('.').pop().toLowerCase();
      if (!MIME[ext]) Log.warn(`알 수 없는 종류의 파일: ${name}`);
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
