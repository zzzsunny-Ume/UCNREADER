// Plays a story built by ucn.js: one page per click, layered images, typed text.
const Player = (() => {
  const CHAR_MS = 35;   // typing speed per character
  const WAIT_MS = 600;  // pause for "#w;"

  let story, urls, idx = -1, timer = null, typing = null;
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
        el.src = urls.get(w.file) || '';
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

  function stopTyping() {
    if (typing) clearTimeout(typing.timer);
    typing = null;
  }

  function paint() {
    const { paras, para, pos } = typing;
    const done = paras.slice(0, para).map((p) => p.join(''));
    $('textbox').textContent = [...done, paras[para].slice(0, pos).join('')].join('\n');
  }

  function step() {
    const t = typing;
    const cur = t.paras[t.para];
    if (t.pos >= cur.length) { t.busy = false; paint(); onTextIdle(); return; }
    const tok = cur[t.pos++];
    if (tok === '') { t.timer = setTimeout(step, WAIT_MS); return; } // "#w;" marker
    paint();
    t.timer = setTimeout(step, CHAR_MS);
  }

  function renderText(pg) {
    stopTyping();
    const box = $('textbox');
    if (!pg.text) { box.hidden = true; return; }
    const t = pg.text;
    Object.assign(box.style, {
      left: `${t.x}px`, top: `${t.y}px`, width: `${t.width}px`, height: `${t.height}px`,
      padding: `${t.vPadding}px ${t.hPadding}px`, textAlign: t.align,
      lineHeight: `${story.fontSize + t.leading}px`, color: `#${t.color.padStart(6, '0')}`,
    });
    box.hidden = false;
    // "#p" splits paragraphs (click to continue); "#w;" becomes an empty token = short pause.
    const paras = t.text.split('#p').map((p) =>
      p.split('#w;').flatMap((seg, i) => (i ? ['', ...Array.from(seg)] : Array.from(seg))));
    typing = { paras, para: 0, pos: 0, busy: true, timer: null };
    step();
  }

  function finishParagraph() {
    clearTimeout(typing.timer);
    typing.pos = typing.paras[typing.para].length;
    typing.busy = false;
    paint();
    onTextIdle();
  }

  function onTextIdle() {
    const pg = story.pages[idx];
    const last = typing.para === typing.paras.length - 1;
    if (last && pg.advance.mode === 'auto') timer = setTimeout(next, pg.advance.ms);
  }

  // ---- navigation ------------------------------------------------------------

  function go(i) {
    clearTimeout(timer);
    stopTyping();
    $('end').hidden = true;
    if (i < 0) i = 0;
    if (i >= story.pages.length) { showEnd(); return; }
    idx = i;
    const pg = story.pages[i];
    renderLayers(pg);
    renderBgm(pg);
    renderText(pg);
    if (!pg.text && pg.advance.mode === 'auto') timer = setTimeout(next, pg.advance.ms);
  }

  function next() { go(idx + 1); }

  function advance() {
    if (idx < 0 || !$('end').hidden) return;
    if (typing?.busy) { finishParagraph(); return; }
    if (typing && typing.para < typing.paras.length - 1) {
      typing.para++;
      typing.pos = 0;
      typing.busy = true;
      step();
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
