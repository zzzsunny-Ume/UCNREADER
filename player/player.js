// Plays a story built by ucn.js: one page per click, layered images, typed text.
const Player = (() => {
  // Original: (50 - scenSpeed / 2) ms per character, reader default scenSpeed = 70.
  const CHAR_MS = 15;

  let story, urls, idx = -1, timer = null, typing = null;
  const vars = {}; // script variables for "$name;" (no UCscript runtime yet)
  const live = new Map(); // node key -> <img>
  const $ = (id) => document.getElementById(id);

  function enter(el, fx) {
    const t = fx?.time || 0;
    if (!fx || fx.effect === 'none' || !t) return 0;
    const frames = fx.effect === 'vortex'
      ? [{ opacity: 0, transform: 'rotate(-360deg) scale(0.2)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 0 }, { opacity: 1 }];
    el.animate(frames, { duration: t, easing: 'ease-out' });
    return t;
  }

  function leave(el, fx, holdMs) {
    const t = fx?.effect === 'fade' ? fx.time : 0;
    if (t) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t, fill: 'forwards' }).onfinish = () => el.remove();
    } else {
      // No exit effect: keep it under whatever is fading in, so nothing flashes black.
      setTimeout(() => el.remove(), holdMs);
    }
  }

  function renderLayers(pg) {
    const want = [pg.background, ...pg.images].filter(Boolean);
    const keys = new Set(want.map((w) => w.key));
    let fadeIn = 0;
    want.forEach((w, i) => {
      let el = live.get(w.key);
      if (!el) {
        el = document.createElement('img');
        el.className = 'layer';
        el.alt = '';
        const url = urls.get(w.file);
        const pageNo = idx + 1;
        if (!url) Log.error(`${pageNo}장: 이미지 파일 없음 "${w.file}" (리소스 ${w.ref})`);
        el.onerror = () => Log.error(`${pageNo}장: 이미지를 표시할 수 없음 "${w.file}" (손상되었거나 지원하지 않는 형식)`);
        el.src = url || '';
        Object.assign(el.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.width}px`, height: `${w.height}px` });
        el._item = w;
        $('layers').append(el);
        live.set(w.key, el);
        fadeIn = Math.max(fadeIn, enter(el, w.effects.start));
      }
      // Background always sits at the bottom; images stack by z (already sorted).
      el.style.zIndex = w === pg.background ? 1 : 10 + i;
    });
    for (const [key, el] of live) {
      if (keys.has(key)) continue;
      el.style.zIndex = 0;
      leave(el, el._item.effects.end, fadeIn);
      live.delete(key);
    }
  }

  function renderBgm(pg) {
    const el = $('bgm');
    const name = pg.bgm ? `▶ ${pg.bgm.ref.replace(/\(\d+\)$/, '').trim()}.mp3` : '';
    if (el.textContent !== name) el.textContent = name;
  }

  // ---- text ----------------------------------------------------------------
  // Mirrors the original player (UCScenario / UCActionTag in UCMobilePlayer4.swf):
  //   "#p" and line breaks end a line and wait for a click (empty lines don't);
  //   "#w;" waits for a click mid-line; "#c;" makes the next line break not wait;
  //   "#d.N;" pauses N seconds; other "#tag;" are script calls (ignored here);
  //   "$name;" / "$arr[i];" print a script variable ("" when undefined).

  function tokenize(text) {
    const s = text.replace(/#p/g, '\n').replace(/\r\n?/g, '\n');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const semi = ch === '$' || ch === '#' ? s.indexOf(';', i) : -1;
      if (semi < 0) { out.push(ch === '\n' ? { t: 'nl' } : { t: 'ch', c: ch }); continue; }
      const tag = s.slice(i + 1, semi);
      i = semi;
      if (ch === '$') {
        for (const c of getVar(tag)) out.push({ t: 'ch', c });
        continue;
      }
      const [name, arg] = tag.split('.');
      if (name === 'w') out.push({ t: 'w' });
      else if (name === 'c') out.push({ t: 'c' });
      else if (name === 'd') out.push({ t: 'd', ms: (parseInt(arg, 10) || 0) * 1000 });
    }
    while (out.length && out[out.length - 1].t === 'nl') out.pop();
    return out;
  }

  function getVar(tag) {
    const m = /^(.*)\[(\d+)\]$/.exec(tag);
    const v = vars[m ? m[1] : tag];
    if (v == null) return '';
    return m ? String(v).split(',')[+m[2]] ?? '' : String(v);
  }

  function stopTyping() {
    if (typing) clearTimeout(typing.timer);
    typing = null;
  }

  function put(str) {
    const box = $('textbox');
    const before = typing.out;
    typing.out += str;
    box.textContent = typing.out;
    // Box full: start over with the current line, like the original clearing its text field.
    if (box.scrollHeight > box.clientHeight + 1) {
      typing.out = before.slice(before.lastIndexOf('\n') + 1) + str;
      box.textContent = typing.out;
    }
  }

  // Runs tokens until the next stop. `fast` skips typing delays (reader clicked).
  function run(fast = false) {
    const t = typing;
    t.state = 'typing';
    while (t.pos < t.tokens.length) {
      const tok = t.tokens[t.pos++];
      if (tok.t === 'ch') {
        put(tok.c);
        if (!fast) { t.timer = setTimeout(run, CHAR_MS); return; }
      } else if (tok.t === 'nl') {
        const emptyLine = t.out === '' || t.out.endsWith('\n');
        if (emptyLine || t.noWait) { t.noWait = false; put('\n'); continue; }
        t.resume = () => put('\n');
        t.state = 'wait';
        return;
      } else if (tok.t === 'w') {
        t.state = 'wait';
        return;
      } else if (tok.t === 'c') {
        t.noWait = true;
      } else if (tok.t === 'd' && !fast) {
        t.timer = setTimeout(run, tok.ms);
        return;
      }
    }
    t.state = 'done';
    const pg = story.pages[idx];
    if (pg.advance.mode === 'auto') timer = setTimeout(next, pg.advance.ms);
  }

  function renderText(pg) {
    stopTyping();
    const box = $('textbox');
    box.textContent = '';
    if (!pg.text) { box.hidden = true; return; }
    const t = pg.text;
    Object.assign(box.style, {
      left: `${t.x}px`, top: `${t.y}px`, width: `${t.width}px`, height: `${t.height}px`,
      padding: `${t.vPadding}px ${t.hPadding}px`, textAlign: t.align,
      lineHeight: `${story.fontSize + t.leading}px`, color: `#${t.color.padStart(6, '0')}`,
    });
    box.hidden = false;
    typing = { tokens: tokenize(t.text), pos: 0, out: '', state: 'typing', timer: null, noWait: false, resume: null };
    run();
  }

  // ---- navigation ------------------------------------------------------------

  function go(i) {
    clearTimeout(timer);
    stopTyping();
    $('end').hidden = true;
    if (i < 0) i = 0;
    if (i >= story.pages.length) { Log.ok('마지막 장까지 재생 완료'); showEnd(); return; }
    idx = i;
    const pg = story.pages[i];
    renderLayers(pg);
    renderBgm(pg);
    renderText(pg);
    const imgs = pg.images.map((m) => m.ref).join(', ');
    Log.info(`${pg.page}장: 배경 ${pg.background?.ref ?? '-'} / 이미지 ${imgs || '-'} / BGM ${pg.bgm?.ref ?? '-'} / ${pg.advance.mode === 'auto' ? `자동 ${pg.advance.ms}ms` : '클릭'}`);
    if (!pg.text && pg.advance.mode === 'auto') timer = setTimeout(next, pg.advance.ms);
  }

  function next() { go(idx + 1); }

  function advance() {
    if (idx < 0 || !$('end').hidden) return;
    if (typing?.state === 'typing') { clearTimeout(typing.timer); run(true); return; }
    if (typing?.state === 'wait') {
      if (typing.resume) { typing.resume(); typing.resume = null; }
      run();
      return;
    }
    clearTimeout(timer);
    next();
  }

  function showEnd() {
    clearTimeout(timer);
    stopTyping();
    $('textbox').hidden = true;
    $('bgm').textContent = '';
    $('end').hidden = false;
  }

  function fit() {
    const stage = $('stage');
    const s = Math.min(window.innerWidth / story.width, window.innerHeight / story.height);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  function start(data) {
    ({ story, urls } = data);
    const stage = $('stage');
    stage.style.width = `${story.width}px`;
    stage.style.height = `${story.height}px`;
    stage.style.fontSize = `${story.fontSize}px`;
    fit();
    window.addEventListener('resize', fit);
    $('player').hidden = false;
    $('begin').hidden = false;
  }

  function begin() {
    $('begin').hidden = true;
    go(0);
  }

  function restart() {
    for (const el of live.values()) el.remove();
    live.clear();
    go(0);
  }

  return {
    start, begin, advance, restart, go,
    back: () => go(idx - 1),
    get page() { return idx + 1; },
  };
})();
