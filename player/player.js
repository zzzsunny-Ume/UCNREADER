// Plays a story built by ucn.js: one page per click, layered images, typed text.
const Player = (() => {
  // Text speed 1..100 as in the original: (50 - speed / 2) ms per character, 100 = whole line at once.
  // A node's own `speed` wins; 0 means "reader setting". The original app defaulted to 70;
  // we default to 100 (no typing animation).
  const READER_SPEED = 100;

  let story, urls, idx = -1, timer = null, typing = null;
  const vars = {}; // script variables for "$name;", set by input boxes (see UCN.parseScript)
  const live = new Map(); // node key -> <img>
  const $ = (id) => document.getElementById(id);

  // ---- transitions ------------------------------------------------------------
  // The original (UCBackground) wipes with a grayscale mask per effect (masks.js): the picture's alpha is
  // mask + 10 + offset, with the offset running 255 → -255 on enter, and on an inverted mask -255 → 255 on
  // exit, so the darkest parts of the mask change first. "fade" is a plain opacity fade.
  const isMask = (fx) => fx && fx.effect in UC_MASKS && fx.effect !== 'fade' && fx.effect !== 'white';
  const masks = new Map(); // effect -> Promise<{ w, h, red } | null>
  const running = new Set();

  function loadMask(effect) {
    if (!masks.has(effect)) {
      masks.set(effect, new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, c.width, c.height).data;
          const red = new Uint8Array(c.width * c.height);
          for (let i = 0; i < red.length; i++) red[i] = px[i * 4];
          resolve({ w: c.width, h: c.height, red });
        };
        img.onerror = () => { Log.warn(`전환 마스크 "${effect}"를 불러오지 못해 효과 없이 표시`); resolve(null); };
        img.src = UC_MASKS[effect];
      }));
    }
    return masks.get(effect);
  }

  // Draws `el` through the mask on a canvas laid over it until the wipe ends, then calls done().
  function maskWipe(el, fx, entering, done) {
    const run = { canvas: null, cancelled: false };
    const finish = () => {
      if (run.cancelled) return;
      run.cancelled = true;
      running.delete(run);
      run.canvas?.remove();
      if (entering) el.style.visibility = '';
      done?.();
    };
    run.cancel = finish;
    running.add(run);
    el._wipe = run;
    if (entering) el.style.visibility = 'hidden';
    Promise.all([loadMask(fx.effect), el.decode().catch(() => null)]).then(([mask]) => {
      if (run.cancelled) return;
      if (!mask || !el.naturalWidth) { finish(); return; }
      const w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      const cv = document.createElement('canvas');
      cv.className = 'layer';
      cv.width = w;
      cv.height = h;
      Object.assign(cv.style, { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height });
      el.after(cv);
      run.canvas = cv;
      const ctx = cv.getContext('2d');
      const mc = document.createElement('canvas');
      mc.width = mask.w;
      mc.height = mask.h;
      const mctx = mc.getContext('2d');
      const img = mctx.createImageData(mask.w, mask.h);
      const shown = new Uint8ClampedArray(256);
      const t0 = performance.now();
      const frame = (now) => {
        if (run.cancelled) return;
        const p = Math.min(1, (now - t0) / fx.time);
        for (let v = 0; v < 256; v++) {
          const cover = entering ? v + 10 + 255 - 510 * p : 10 - v + 510 * p;
          shown[v] = 255 - Math.max(0, Math.min(255, cover));
        }
        for (let i = 0, a = 3; i < mask.red.length; i++, a += 4) img.data[a] = shown[mask.red[i]];
        mctx.putImageData(img, 0, 0);
        cv.style.zIndex = el.style.zIndex;
        cv.style.transform = getComputedStyle(el).transform; // follow any motion on the layer
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(el, 0, 0, w, h);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(mc, 0, 0, w, h);
        if (!entering) el.style.visibility = 'hidden';
        if (p < 1) requestAnimationFrame(frame);
        else finish();
      };
      requestAnimationFrame(frame);
    });
  }

  // ---- motion -------------------------------------------------------------------
  // Position/scale/rotation tween that runs alongside the effect (UCComponent / UCBackground.makeTween):
  // enter moves from (-x, -y), scaled and rotated, into place; exit moves from place to (-x, -y) and the
  // scale (exit rotation does nothing in the original). Scale is width/height in % for images and in
  // stage pixels for backgrounds; scaling is about the centre.
  const EASE = {
    none: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', // TweenMax default, Power1.easeOut
    accel: 'cubic-bezier(0.755, 0.05, 0.855, 0.06)', // Power4.easeIn
    decel: 'cubic-bezier(0.23, 1, 0.32, 1)', // Power4.easeOut
    over: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)', // Back.easeOut
  };

  function motion(el, fx, entering, isBg) {
    const t = fx.time;
    const base = isBg ? [story.width, story.height] : [100, 100];
    const sx = fx.width == null ? 1 : fx.width / base[0];
    const sy = fx.height == null ? 1 : fx.height / base[1];
    const moved = fx.x || fx.y || sx !== 1 || sy !== 1 || (entering && fx.rotation);
    if (moved) {
      const off = `translate(${-fx.x}px, ${-fx.y}px) scale(${sx}, ${sy})${entering && fx.rotation ? ` rotate(${fx.rotation}deg)` : ''}`;
      const frames = entering ? [{ transform: off }, { transform: 'none' }] : [{ transform: 'none' }, { transform: off }];
      el.animate(frames, { duration: t, easing: EASE[fx.option] ?? EASE.none, fill: entering ? 'none' : 'forwards' });
    }
    if (fx.option === 'hquake' || fx.option === 'vquake') {
      // Every 0.1 s jump 10–15 px aside and back, for the whole effect.
      const frames = [];
      const steps = Math.max(1, Math.round(t / 100));
      for (let i = 0; i < steps; i++) {
        const d = 10 + Math.random() * 5;
        frames.push({ translate: '0 0' }, { translate: fx.option === 'hquake' ? `${d}px 0` : `0 ${d}px` });
      }
      frames.push({ translate: '0 0' });
      el.animate(frames, { duration: t });
    }
    return moved || fx.option === 'hquake' || fx.option === 'vquake';
  }

  // "white" (backgrounds): a white sheet over the picture fades out on enter and in on exit
  // (UCBackground.whiteMaskEffect), so the picture comes out of, or goes into, white.
  function whiteWipe(el, fx, entering, done) {
    const sheet = document.createElement('div');
    sheet.className = 'layer white-sheet';
    Object.assign(sheet.style, { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, zIndex: el.style.zIndex });
    el.after(sheet);
    const run = { cancelled: false };
    const finish = () => {
      if (run.cancelled) return;
      run.cancelled = true;
      running.delete(run);
      sheet.remove();
      done?.();
    };
    run.cancel = finish;
    running.add(run);
    el._wipe = run;
    // Keep the sheet in the layer's stacking slot even after renderLayers re-sorts z.
    const anim = sheet.animate([{ opacity: entering ? 1 : 0 }, { opacity: entering ? 0 : 1 }], { duration: fx.time, fill: 'forwards' });
    const follow = () => { if (!run.cancelled) { sheet.style.zIndex = el.style.zIndex; requestAnimationFrame(follow); } };
    requestAnimationFrame(follow);
    anim.onfinish = finish;
  }

  // Backgrounds take the mask and white wipes; images only fade (other effect names just move),
  // as in UCBackground / UCComponent.
  function enter(el, fx, isBg) {
    const t = fx?.time || 0;
    if (!fx || !t) return 0;
    const moving = motion(el, fx, true, isBg);
    if (fx.effect === 'fade') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: t, easing: 'ease-out' });
    else if (isBg && fx.effect === 'white') whiteWipe(el, fx, true);
    else if (isBg && isMask(fx)) maskWipe(el, fx, true);
    else if (!moving) return 0;
    return t;
  }

  function leave(el, fx, holdMs) {
    el._wipe?.cancel();
    const isBg = el._isBg;
    const t = fx?.time || 0;
    const moving = t ? motion(el, fx, false, isBg) : false;
    if (t && isBg && fx.effect === 'white') {
      whiteWipe(el, fx, false, () => el.remove());
    } else if (t && isBg && isMask(fx)) {
      maskWipe(el, fx, false, () => el.remove());
    } else if (t && fx.effect === 'fade') {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t, fill: 'forwards' }).onfinish = () => el.remove();
    } else if (moving) {
      setTimeout(() => el.remove(), t);
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
        el._isBg = w === pg.background;
        $('layers').append(el);
        live.set(w.key, el);
        fadeIn = Math.max(fadeIn, enter(el, w.effects.start, el._isBg));
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

  // The rest of the current line, not shown yet.
  function pendingLine() {
    let s = '';
    for (let i = typing.pos; i < typing.tokens.length && typing.tokens[i].t !== 'nl'; i++) {
      if (typing.tokens[i].t === 'ch') s += typing.tokens[i].c;
    }
    return s;
  }

  // Like the original, the whole line is laid out first and revealed in place: the part not shown
  // yet is kept as invisible text, so centred text doesn't shift when "#w;" continues the line.
  function paint() {
    const ghost = document.createElement('span');
    ghost.className = 'ghost';
    ghost.textContent = pendingLine();
    $('textbox').replaceChildren(typing.out, ghost);
  }

  function put(str) {
    const box = $('textbox');
    const before = typing.out;
    typing.out += str;
    paint();
    // Box full: start over with the current line, like the original clearing its text field.
    if (box.scrollHeight > box.clientHeight + 1) {
      typing.out = before.slice(before.lastIndexOf('\n') + 1) + str;
      paint();
    }
  }

  // Runs tokens until the next stop. `skip` (reader clicked) also skips "#d.N;" pauses.
  function run(skip = false) {
    const t = typing;
    const instant = skip || t.charMs === 0;
    t.state = 'typing';
    while (t.pos < t.tokens.length) {
      const tok = t.tokens[t.pos++];
      if (tok.t === 'ch') {
        put(tok.c);
        if (!instant) { t.timer = setTimeout(run, t.charMs); return; }
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
      } else if (tok.t === 'd' && !skip) {
        t.timer = setTimeout(run, tok.ms);
        return;
      }
    }
    t.state = 'done';
    const pg = story.pages[idx];
    if (pg.advance.mode === 'auto') timer = setTimeout(next, pg.advance.ms);
  }

  const rgba = (hex, a) => {
    const n = parseInt(hex || '0', 16) || 0;
    return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
  };

  // ---- input boxes -------------------------------------------------------------
  // Layout follows UCInput: an entry field and a button inside the node's box; submitting runs the
  // node's onInput handler from the work's script (usually: store the value, go to the next page).
  const inputs = new Map(); // node id -> element

  function renderInputs(pg) {
    const want = new Set(pg.inputs.map((n) => n.key));
    for (const [key, el] of inputs) if (!want.has(key)) { el.remove(); inputs.delete(key); }
    for (const n of pg.inputs) {
      if (inputs.has(n.key)) continue;
      const st = n.style || {};
      const box = document.createElement('form');
      box.className = 'uc-input';
      Object.assign(box.style, {
        left: `${n.x}px`, top: `${n.y}px`, width: `${n.width}px`, height: `${n.height}px`,
        backgroundColor: rgba(st.background, (st.opacity ?? 0) / 100),
        border: st.border > 0 ? `1px solid #${(st.bordercolor || 'ffffff').padStart(6, '0')}` : 'none',
        borderRadius: `${(st.radius || 0) * 2}px`,
        color: `#${(st.btncolor || 'ffffff').padStart(6, '0')}`,
      });
      const field = document.createElement('input');
      field.type = 'text';
      field.maxLength = 20;
      field.autocomplete = 'off';
      field.setAttribute('aria-label', '입력');
      const first = n.handler?.find((x) => x.op === 'set');
      if (first && vars[first.name]) field.value = vars[first.name];
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.textContent = '확인';
      Object.assign(btn.style, {
        backgroundColor: rgba(st.btnbackground || 'ffffff', (st.btnopacity ?? 0) / 100),
        color: `#${(st.btncolor || 'ffffff').padStart(6, '0')}`,
      });
      box.append(field, btn);
      // Keep taps and keys inside the box from turning the page.
      for (const ev of ['click', 'pointerdown', 'keydown']) box.addEventListener(ev, (e) => e.stopPropagation());
      box.addEventListener('submit', (e) => {
        e.preventDefault();
        const value = field.value.trim();
        if (!value) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); field.focus(); return; }
        submitInput(n, value);
      });
      $('stage').append(box);
      inputs.set(n.key, box);
      setTimeout(() => field.focus({ preventScroll: true }), 50);
    }
  }

  function submitInput(n, value) {
    const steps = n.handler ?? [{ op: 'set', name: n.id }, { op: 'next' }];
    if (!n.handler) Log.warn(`입력창 ${n.id}에 연결된 onInput 처리가 없어 값만 저장하고 넘어감`);
    for (const step of steps) {
      if (step.op === 'set') {
        vars[step.name] = value;
        Log.ok(`${idx + 1}장 입력: 변수 "${step.name}"에 ${[...value].length}자 저장`);
      } else if (step.op === 'next') { next(); return; }
      else if (step.op === 'prev') { go(idx - 1); return; }
    }
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
      // Text window as UCScenario draws it: fill with alpha, 1px border, rounded corners (radius × 4 wide).
      backgroundColor: rgba(t.bg, t.bgOpacity / 100),
      border: t.border > 0 ? `1px solid #${t.bordercolor.padStart(6, '0')}` : 'none',
      borderRadius: `${t.radius * 2}px`,
    });
    box.hidden = false;
    const speed = t.speed || READER_SPEED;
    const charMs = speed >= 100 ? 0 : 50 - speed / 2;
    typing = { tokens: tokenize(t.text), pos: 0, out: '', state: 'typing', timer: null, noWait: false, resume: null, charMs };
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
    try {
      renderLayers(pg);
      renderBgm(pg);
      renderText(pg);
      renderInputs(pg);
    } catch (e) {
      // Something in this page broke the player: note it and carry on with the next page.
      Log.error(`${pg.page}장을 그리다 오류가 나서 다음 장으로 넘어감: ${e.message || e}`);
      timer = setTimeout(next, 800);
      return;
    }
    const imgs = pg.images.map((m) => m.ref).join(', ');
    for (const msg of pg.notes) Log.warn(`${pg.page}장: ${msg}`);
    Log.info(`${pg.page}장: 배경 ${pg.background?.ref ?? '-'} / 이미지 ${imgs || '-'} / BGM ${pg.bgm?.ref ?? '-'} / ${{ auto: `자동 ${pg.advance.ms}ms`, input: '입력 대기' }[pg.advance.mode] ?? '클릭'}`);
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
    // Input pages only move on when the box is submitted.
    if (story.pages[idx].advance.mode === 'input') { $('stage').querySelector('.uc-input input')?.focus(); return; }
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
    Object.assign(vars, story.vars);
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
    for (const run of [...running]) run.cancel();
    for (const el of live.values()) el.remove();
    live.clear();
    for (const el of inputs.values()) el.remove();
    inputs.clear();
    go(0);
  }

  return {
    start, begin, advance, restart, go,
    back: () => go(idx - 1),
    get page() { return idx + 1; },
  };
})();
