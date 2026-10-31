// In-page log shared by the parser and the player; shown in the "Log 보기" panel.
const Log = (() => {
  const entries = [];
  const listeners = [];
  const counts = { info: 0, ok: 0, warn: 0, error: 0 };
  const LABEL = { info: 'INFO', ok: ' OK ', warn: 'WARN', error: 'ERR ' };

  function add(level, msg) {
    const e = { time: new Date(), level, msg: String(msg) };
    entries.push(e);
    counts[level]++;
    for (const f of listeners) f(e);
  }

  const stamp = (d) => d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const line = (e) => `${stamp(e.time)} [${LABEL[e.level]}] ${e.msg}`;

  return {
    info: (m) => add('info', m),
    ok: (m) => add('ok', m),
    warn: (m) => add('warn', m),
    error: (m) => add('error', m),
    onAdd: (f) => listeners.push(f),
    entries,
    counts,
    line,
    // levels: optional list, e.g. ['warn', 'error'] for problems only.
    text: (levels) => entries.filter((e) => !levels || levels.includes(e.level)).map(line).join('\n'),
  };
})();

window.addEventListener('error', (e) => Log.error(`스크립트 오류: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => Log.error(`처리되지 않은 오류: ${e.reason?.message || e.reason}`));
