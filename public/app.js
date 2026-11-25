'use strict';

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const PAGE = 1500;            // rows kept in the DOM per page
const MAX_ENTRIES = 150000;   // entries kept in memory
const PALETTE = ['#3ddc84', '#5ac8fa', '#ff9f0a', '#bf5af2', '#ff6482', '#64d2ff', '#ffd60a'];
const CRASH = /FATAL EXCEPTION|Terminating app due to uncaught exception|Fatal error:|EXC_BAD_ACCESS|EXC_CRASH|SIGABRT|SIGSEGV/;

const $ = id => document.getElementById(id);
const el = {
  conn: $('conn'), devices: $('devices'), q: $('q'), qclear: $('qclear'), levels: $('levels'), appOnly: $('appOnly'), hideSystem: $('hideSystem'),
  pause: $('pause'), mark: $('mark'), clear: $('clear'), export: $('export'), wrap: $('wrap'), theme: $('theme'),
  list: $('list'), rows: $('rows'), more: $('more'), empty: $('empty'), jump: $('jump'),
  shown: $('shown'), rate: $('rate'), crashes: $('crashes'),
};

const prefs = Object.assign({ q: '', minLevel: 'V', appOnly: true, hideSystem: true, wrap: false, hidden: [] }, readPrefs());
function readPrefs() { try { return JSON.parse(localStorage.getItem('mlv-prefs') || '{}'); } catch { return {}; } }
function savePrefs() {
  try { localStorage.setItem('mlv-prefs', JSON.stringify({ ...prefs, theme: document.documentElement.dataset.theme })); } catch {}
}

const state = {
  entries: [],
  bySeq: new Map(),
  devices: new Map(),
  colors: new Map(),
  pidNames: new Map(),
  apps: { android: [], ios: [] },
  tools: {},
  view: [],
  limit: PAGE,
  stick: true,
  paused: false,
  queued: [],
  unseen: 0,
  tests: [],
  highlight: null,
  open: new Set(),
  crashCursor: -1,
  received: 0,
  loaded: false,
};

// ---------- filtering ----------
function procOf(e) { return e.proc || state.pidNames.get(e.dev)?.get(e.pid) || ''; }
function devName(id) { return state.devices.get(id)?.name || id; }
function hay(e) { return e._lc || (e._lc = `${e.msg}\n${e.tag}\n${procOf(e)}`.toLowerCase()); }
// iOS "Fault" is an ordinary os_log level, so only Android's fatal level counts as a crash by itself.
function isCrash(e) {
  if (e._crash === undefined) {
    const android = state.devices.get(e.dev)?.platform === 'android';
    e._crash = (android && e.lvl === 'F') || (e.tag === 'AndroidRuntime' && e.lvl === 'E') || CRASH.test(e.msg);
  }
  return e._crash;
}

function isApp(e) {
  const p = procOf(e);
  if (!p) return false;
  const dev = state.devices.get(e.dev);
  // No apps configured for a platform: App only does not filter it.
  if (dev?.platform === 'android') {
    const apps = state.apps.android;
    return !apps.length || apps.some(a => p === a || p.startsWith(a + '.') || p.startsWith(a + ':'));
  }
  return !state.apps.ios.length || state.apps.ios.includes(p);
}

// iOS logs from Apple frameworks inside the app process (Network, CFNetwork, UIKitCore…) outnumber the app's own
// lines about 100 to 1. The app's own code (and SDKs linked into it) logs under the app image name.
function isSystem(e) {
  const dev = state.devices.get(e.dev);
  if (!dev || dev.platform === 'android') return false;
  if (dev.platform === 'sim') return e.tag.startsWith('com.apple');
  if (!state.apps.ios.length) return false;
  return !!e.tag && !state.apps.ios.some(a => e.tag === a || e.tag.startsWith(a + '.'));
}

function compile(q) {
  const tests = [];
  const marks = [];
  let bad = false;
  for (let raw of q.match(/-?\w+:"[^"]*"|-?"[^"]*"|\S+/g) || []) {
    let neg = false;
    if (raw.length > 1 && raw.startsWith('-')) { neg = true; raw = raw.slice(1); }
    let field = null;
    const fm = /^(tag|proc|dev|pid|lvl):(.+)$/i.exec(raw);
    if (fm) { field = fm[1].toLowerCase(); raw = fm[2]; }
    raw = raw.replace(/^"(.*)"$/, '$1');
    if (!raw) continue;
    let re = null;
    const rm = /^\/(.+)\/$/.exec(raw);
    if (rm) {
      try { re = new RegExp(rm[1], 'i'); } catch { bad = true; continue; }
    }
    const needle = raw.toLowerCase();
    const value = field === 'tag' ? e => e.tag.toLowerCase()
      : field === 'proc' ? e => procOf(e).toLowerCase()
      : field === 'dev' ? e => devName(e.dev).toLowerCase()
      : field === 'pid' ? e => String(e.pid)
      : field === 'lvl' ? e => e.lvl.toLowerCase()
      : hay;
    const fn = re ? e => re.test(value(e)) : e => value(e).includes(needle);
    tests.push(neg ? e => !fn(e) : fn);
    if (!neg && !field) marks.push(re ? re.source : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  state.tests = tests;
  state.highlight = marks.length ? new RegExp(marks.join('|'), 'gi') : null;
  el.q.parentElement.classList.toggle('bad', bad);
}

function matches(e) {
  if (e.dev === 'mark') return true;
  if (prefs.hidden.includes(e.dev)) return false;
  if (RANK[e.lvl] < RANK[prefs.minLevel]) return false;
  if (prefs.appOnly && !isApp(e)) return false;
  if (prefs.hideSystem && RANK[e.lvl] < RANK.E && isSystem(e)) return false;
  for (const t of state.tests) if (!t(e)) return false;
  return true;
}

// ---------- rendering ----------
const esc = s => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function clock(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; }

function highlight(text) {
  const re = state.highlight;
  if (!re) return esc(text);
  let out = '', last = 0;
  re.lastIndex = 0;
  for (let m; (m = re.exec(text));) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function decorate(html) {
  return html
    .replace(/(&lt;-- )([1-3]\d\d)\b/, '$1<span class="http-ok">$2</span>')
    .replace(/(&lt;-- )(4\d\d)\b/, '$1<span class="http-warn">$2</span>')
    .replace(/(&lt;-- )(5\d\d|HTTP FAILED)/, '$1<span class="http-err">$2</span>');
}

function rowHtml(e) {
  if (e.dev === 'mark') return `<div class="marker" data-seq="${e.seq}">${esc(e.msg || 'Mark')} · ${clock(e.ts)}</div>`;
  const lines = e.msg.split('\n');
  const first = prefs.wrap ? e.msg : lines[0];
  const extra = !prefs.wrap && lines.length > 1 ? `<span class="extra">+${lines.length - 1} lines</span>` : '';
  const json = /[{[]/.test(e.msg) && findJson(e.msg) ? '<span class="badge">JSON</span>' : '';
  const proc = procOf(e);
  const short = proc.replace(/^com\./, '');
  const crash = isCrash(e) ? ' crash' : '';
  return `<div class="row l-${e.lvl}${crash}${state.open.has(e.seq) ? ' open' : ''}" data-seq="${e.seq}">`
    + `<span class="t">${clock(e.ts)}</span>`
    + `<span class="d" style="--c:${state.colors.get(e.dev) || 'var(--muted)'}">${esc(devName(e.dev))}</span>`
    + `<span class="lv">${e.lvl}</span>`
    + `<span class="p" title="${esc(proc)} · pid ${e.pid}">${esc(short || String(e.pid || ''))}</span>`
    + `<span class="g" title="${esc(e.tag)}">${esc(e.tag)}</span>`
    + `<span class="m">${decorate(highlight(first))}${extra}${json}</span>`
    + `</div>`;
}

function renderAll() {
  state.view = state.entries.filter(matches);
  const start = Math.max(0, state.view.length - state.limit);
  const html = [];
  for (let i = start; i < state.view.length; i++) {
    html.push(rowHtml(state.view[i]));
    if (state.open.has(state.view[i].seq)) html.push(detailHtml(state.view[i]));
  }
  el.rows.innerHTML = html.join('');
  updateMore(start);
  updateStatus();
  if (state.stick) toBottom();
}

function appendRows(batch) {
  const fresh = batch.filter(matches);
  if (!fresh.length) return updateStatus();
  state.view.push(...fresh);
  el.rows.insertAdjacentHTML('beforeend', fresh.map(rowHtml).join(''));
  if (state.stick) {
    let extra = el.rows.querySelectorAll('.row, .marker').length - state.limit;
    while (extra-- > 0 && el.rows.firstElementChild) {
      const first = el.rows.firstElementChild;
      if (first.nextElementSibling?.classList.contains('detail')) first.nextElementSibling.remove();
      first.remove();
    }
    toBottom();
  } else {
    state.unseen += fresh.length;
    el.jump.hidden = false;
    el.jump.textContent = `↓ ${state.unseen.toLocaleString()} new`;
  }
  const visible = el.rows.querySelectorAll('.row, .marker').length;
  updateMore(state.view.length - visible);
  updateStatus();
}

function updateMore(hiddenAbove) {
  el.more.hidden = hiddenAbove <= 0;
  el.more.textContent = `Show ${Math.min(PAGE, hiddenAbove).toLocaleString()} earlier · ${hiddenAbove.toLocaleString()} more above`;
}

function updateStatus() {
  const total = state.entries.length;
  el.shown.textContent = `${state.view.length.toLocaleString()} shown · ${total.toLocaleString()} total`
    + (state.paused ? ` · paused, ${state.queued.length.toLocaleString()} waiting` : '');
  const crashes = state.view.filter(isCrash).length;
  el.crashes.hidden = !crashes;
  el.crashes.textContent = `${crashes} crash${crashes === 1 ? '' : 'es'}`;
  renderEmpty();
}

function renderEmpty() {
  const anyDevice = [...state.devices.values()].some(d => d.connected);
  if (state.view.length) { el.empty.innerHTML = ''; return; }
  if (!state.loaded) { el.empty.innerHTML = '<b>Connecting…</b>'; return; }
  if (!anyDevice) {
    const missing = Object.entries(state.tools).filter(([, ok]) => !ok).map(([k]) => k);
    el.empty.innerHTML = '<b>No device yet</b>Plug in a phone, or connect <code>adb</code> over Wi-Fi. Checking every 3 s.'
      + (missing.length ? `<br><br>Not installed: <code>${missing.join(', ')}</code>` : '');
    return;
  }
  if (state.entries.length) {
    el.empty.innerHTML = '<b>Nothing matches</b>'
      + (prefs.appOnly ? 'App only is on. Open the app, or turn App only off to see the whole device.' : 'Loosen the search or the level.');
  } else {
    el.empty.innerHTML = '<b>Waiting for logs</b>Open the app on the device.';
  }
}

function toBottom() { el.list.scrollTop = el.list.scrollHeight; }

// ---------- detail ----------
function findJson(msg) {
  const t = msg.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return [JSON.parse(t)]; } catch {}
  }
  const open = msg.search(/[{[]/);
  if (open >= 0) {
    const j = msg.lastIndexOf(msg[open] === '{' ? '}' : ']');
    if (j > open && msg.indexOf('\n', open) >= 0) {
      try { return [JSON.parse(msg.slice(open, j + 1))]; } catch {}
    }
  }
  const found = [];
  for (const line of msg.split('\n')) {
    const i = line.search(/[{[]/);
    if (i < 0) continue;
    const close = line[i] === '{' ? '}' : ']';
    const j = line.lastIndexOf(close);
    if (j <= i) continue;
    try { found.push(JSON.parse(line.slice(i, j + 1))); } catch {}
    if (found.length >= 5) break;
  }
  return found.length ? found : null;
}

// When the message is a header followed by one JSON body, show the header and the formatted body, not the raw body twice.
function rawBefore(msg, json) {
  if (!json || json.length !== 1) return msg;
  const open = msg.search(/[{[]/);
  const close = msg.lastIndexOf(msg[open] === '{' ? '}' : ']');
  if (open < 0 || msg.slice(close + 1).trim()) return msg;
  try { JSON.parse(msg.slice(open, close + 1)); } catch { return msg; }
  return msg.slice(0, open).trim();
}

function prettyJson(value) {
  return esc(JSON.stringify(value, null, 2)).replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, colon, lit) => str ? `<span class="${colon ? 'j-key' : 'j-str'}">${str}</span>${colon || ''}`
      : lit ? `<span class="j-lit">${m}</span>` : `<span class="j-num">${m}</span>`);
}

function detailHtml(e) {
  const d = new Date(e.ts);
  const json = findJson(e.msg);
  const proc = procOf(e);
  return `<div class="detail" data-for="${e.seq}">`
    + `<div class="meta"><span><b>${esc(devName(e.dev))}</b></span><span>${d.toLocaleDateString()} ${clock(e.ts)}</span>`
    + `<span>${esc(proc || '?')} · pid ${e.pid}${e.tid ? ` · tid ${e.tid}` : ''}</span><span>tag <b>${esc(e.tag || '—')}</b></span></div>`
    + (rawBefore(e.msg, json) ? `<pre>${decorate(highlight(rawBefore(e.msg, json)))}</pre>` : '')
    + (json ? json.map(j => `<pre>${prettyJson(j)}</pre>`).join('') : '')
    + `<div class="tools">`
    + `<button data-act="copy">Copy message</button>`
    + (json ? `<button data-act="copy-json">Copy JSON</button>` : '')
    + (e.tag ? `<button data-act="tag">Only tag</button><button data-act="hide-tag">Hide tag</button>` : '')
    + (proc ? `<button data-act="proc">Only this process</button>` : '')
    + `<button data-act="context">Show around</button>`
    + `</div></div>`;
}

el.rows.addEventListener('click', ev => {
  const act = ev.target.closest('[data-act]');
  if (act) return detailAction(act.dataset.act, Number(act.closest('.detail').dataset.for));
  if (ev.target.closest('.detail')) return;
  if (getSelection().toString()) return;
  const row = ev.target.closest('.row');
  if (!row) return;
  const seq = Number(row.dataset.seq);
  const e = state.bySeq.get(seq);
  if (!e) return;
  if (state.open.has(seq)) {
    state.open.delete(seq);
    row.classList.remove('open');
    row.nextElementSibling?.classList.contains('detail') && row.nextElementSibling.remove();
  } else {
    state.open.add(seq);
    row.classList.add('open');
    row.insertAdjacentHTML('afterend', detailHtml(e));
  }
});

function setQuery(q) {
  el.q.value = q;
  onQuery();
}
function detailAction(act, seq) {
  const e = state.bySeq.get(seq);
  if (!e) return;
  const quote = s => (/\s/.test(s) ? `"${s}"` : s);
  if (act === 'copy') return copy(e.msg);
  if (act === 'copy-json') return copy((findJson(e.msg) || []).map(j => JSON.stringify(j, null, 2)).join('\n\n'));
  if (act === 'tag') return setQuery(`tag:${quote(e.tag)}`);
  if (act === 'hide-tag') return setQuery(`${el.q.value} -tag:${quote(e.tag)}`.trim());
  if (act === 'proc') return setQuery(`proc:${quote(procOf(e))}`);
  if (act === 'context') {
    el.q.value = '';
    prefs.q = '';
    compile('');
    state.limit = Math.max(PAGE, state.entries.length);
    state.stick = false;
    renderAll();
    const row = el.rows.querySelector(`.row[data-seq="${seq}"]`);
    if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); }
    savePrefs();
  }
}
function copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); }

// ---------- devices ----------
function renderDevices() {
  const list = [...state.devices.values()];
  list.forEach(d => { if (!state.colors.has(d.id)) state.colors.set(d.id, PALETTE[state.colors.size % PALETTE.length]); });
  document.body.classList.toggle('single-dev', list.length <= 1);
  if (!list.length) { el.devices.innerHTML = '<span class="none">No device</span>'; return; }
  el.devices.innerHTML = list.map(d => {
    const plat = d.platform === 'android' ? 'Android' : d.platform === 'ios' ? 'iOS' : 'Simulator';
    const live = d.connected && d.streaming;
    const status = !d.connected ? (d.note ? `Not ready: ${d.note}` : 'Disconnected') : d.error ? `Error: ${d.error}` : live ? 'Streaming' : 'Stopped';
    const mode = d.platform !== 'android'
      ? `<select data-mode="${esc(d.id)}" title="App: only your app processes (MLOG_IOS_APPS, light). All: whole device, noisy"><option value="app"${d.mode === 'app' ? ' selected' : ''}>App</option><option value="all"${d.mode === 'all' ? ' selected' : ''}>All</option></select>`
      : '';
    const icon = d.wantStream ? '<path d="M5 3h2v10H5zM9 3h2v10H9z"/>' : '<path d="M5 3l8 5-8 5z"/>';
    return `<div class="chip${prefs.hidden.includes(d.id) ? ' hidden' : ''}${d.connected ? '' : ' gone'}" style="--c:${state.colors.get(d.id)}">`
      + `<button class="vis" data-vis="${esc(d.id)}" title="${esc(status)} · click to show/hide">`
      + `<span class="swatch"></span><span>${esc(d.name || d.id)}</span><span class="plat">${plat}</span>`
      + `<span class="count">${(d.count || 0).toLocaleString()}</span>`
      + `<span class="state ${d.error ? 'err' : live ? 'live' : ''}"></span></button>`
      + mode
      + `<button class="run" data-run="${esc(d.id)}" title="${d.wantStream ? 'Stop streaming' : 'Start streaming'}"><svg viewBox="0 0 16 16">${icon}</svg></button>`
      + `<button class="run" data-forget="${esc(d.id)}" title="Forget this device"><svg viewBox="0 0 16 16"><path d="M4.4 3.3 8 6.9l3.6-3.6 1.1 1.1L9.1 8l3.6 3.6-1.1 1.1L8 9.1l-3.6 3.6-1.1-1.1L6.9 8 3.3 4.4z"/></svg></button>`
      + `</div>`;
  }).join('');
}

el.devices.addEventListener('click', ev => {
  const vis = ev.target.closest('[data-vis]');
  const run = ev.target.closest('[data-run]');
  const gone = ev.target.closest('[data-forget]');
  if (gone) {
    const d = state.devices.get(gone.dataset.forget);
    if (d && confirm(`Forget ${d.name || d.id}? Its logs are removed and it stays hidden, even while still paired. Undo by removing it from ignoreDevices in config.local.json.`)) {
      post(`/api/devices/${encodeURIComponent(d.id)}/forget`, {});
    }
  } else if (vis) {
    const id = vis.dataset.vis;
    prefs.hidden = prefs.hidden.includes(id) ? prefs.hidden.filter(x => x !== id) : [...prefs.hidden, id];
    savePrefs(); renderDevices(); renderAll();
  } else if (run) {
    const d = state.devices.get(run.dataset.run);
    post(`/api/devices/${encodeURIComponent(d.id)}/stream`, { on: !d.wantStream });
  }
});
el.devices.addEventListener('change', ev => {
  const id = ev.target.dataset.mode;
  if (id) post(`/api/devices/${encodeURIComponent(id)}/mode`, { mode: ev.target.value });
});

function post(url, data) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {});
}

// ---------- stream ----------
function ingest(batch) {
  state.received += batch.length;
  for (const e of batch) { state.entries.push(e); state.bySeq.set(e.seq, e); }
  if (state.entries.length > MAX_ENTRIES) {
    const drop = state.entries.splice(0, state.entries.length - MAX_ENTRIES + 10000);
    drop.forEach(e => { state.bySeq.delete(e.seq); state.open.delete(e.seq); });
    if (!state.paused) return scheduleRender();
  }
  if (!state.loaded) return;
  if (state.paused) { state.queued.push(...batch); updateStatus(); return; }
  appendRows(batch);
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAll, 120);
}

let source;
function connect() {
  source = new EventSource('/events');
  source.addEventListener('hello', ev => {
    const data = JSON.parse(ev.data);
    state.apps = { android: data.apps?.android || [], ios: data.apps?.ios || [] };
    state.tools = data.tools || {};
    state.entries = []; state.bySeq.clear(); state.queued = []; state.loaded = false; state.open.clear();
    el.conn.className = 'conn ok';
    el.conn.title = 'Connected';
  });
  source.addEventListener('devices', ev => {
    state.devices = new Map(JSON.parse(ev.data).map(d => [d.id, d]));
    renderDevices();
    if (state.loaded && !state.view.length) renderEmpty();
  });
  source.addEventListener('procs', ev => {
    const { dev, map } = JSON.parse(ev.data);
    if (!state.pidNames.has(dev)) state.pidNames.set(dev, new Map());
    const names = state.pidNames.get(dev);
    let touched = false;
    for (const [pid, name] of Object.entries(map)) names.set(Number(pid), name);
    for (const e of state.entries) {
      if (e.dev === dev && !e.proc && names.has(e.pid)) { e.proc = names.get(e.pid); e._lc = null; touched = true; }
    }
    if (touched && state.loaded && !state.paused) scheduleRender();
  });
  source.addEventListener('logs', ev => ingest(JSON.parse(ev.data)));
  source.addEventListener('ready', () => { state.loaded = true; state.stick = true; renderAll(); });
  source.addEventListener('cleared', ev => {
    const { dev } = JSON.parse(ev.data);
    state.entries = dev ? state.entries.filter(e => e.dev !== dev) : [];
    state.queued = dev ? state.queued.filter(e => e.dev !== dev) : [];
    state.bySeq = new Map(state.entries.map(e => [e.seq, e]));
    state.open.clear();
    state.limit = PAGE;
    state.stick = true;
    renderAll();
  });
  source.onerror = () => { el.conn.className = 'conn down'; el.conn.title = 'Disconnected from the viewer server. Retrying…'; };
}

setInterval(() => {
  el.rate.textContent = state.received ? `${state.received.toLocaleString()}/s` : '';
  state.received = 0;
}, 1000);

// ---------- controls ----------
function renderLevels() {
  el.levels.innerHTML = LEVELS.map(l =>
    `<button class="l-${l}${RANK[l] >= RANK[prefs.minLevel] ? ' on' : ''}${l === prefs.minLevel ? ' min' : ''}" data-l="${l}" title="Show ${l} and above">${l}</button>`).join('');
}
el.levels.addEventListener('click', ev => {
  const b = ev.target.closest('[data-l]');
  if (!b) return;
  setLevel(b.dataset.l);
});
function setLevel(l) {
  prefs.minLevel = l;
  savePrefs(); renderLevels(); renderAll();
}

let queryTimer = null;
function onQuery() {
  prefs.q = el.q.value;
  el.qclear.hidden = !prefs.q;
  compile(prefs.q);
  savePrefs();
  state.limit = PAGE;
  state.stick = true;
  renderAll();
}
el.q.addEventListener('input', () => { clearTimeout(queryTimer); queryTimer = setTimeout(onQuery, 150); });
el.q.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { if (el.q.value) setQuery(''); else el.q.blur(); }
});
el.qclear.addEventListener('click', () => { setQuery(''); el.q.focus(); });

el.appOnly.addEventListener('change', () => { prefs.appOnly = el.appOnly.checked; savePrefs(); renderAll(); });
el.hideSystem.addEventListener('change', () => { prefs.hideSystem = el.hideSystem.checked; savePrefs(); renderAll(); });

function togglePause() {
  state.paused = !state.paused;
  el.pause.textContent = state.paused ? 'Resume' : 'Pause';
  el.pause.classList.toggle('paused', state.paused);
  if (!state.paused && state.queued.length) {
    const batch = state.queued; state.queued = [];
    appendRows(batch);
  }
  updateStatus();
}
el.pause.addEventListener('click', togglePause);

function mark(named) {
  const text = named ? prompt('Marker text') : '';
  if (text === null) return;
  post('/api/mark', { text: text || 'Mark' });
}
el.mark.addEventListener('click', ev => mark(ev.shiftKey));
el.clear.addEventListener('click', () => post('/api/clear', {}));

function toggleWrap() {
  prefs.wrap = !prefs.wrap;
  el.wrap.setAttribute('aria-pressed', prefs.wrap);
  document.body.classList.toggle('wrap', prefs.wrap);
  savePrefs(); renderAll();
}
el.wrap.addEventListener('click', toggleWrap);
el.theme.addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  savePrefs();
});

el.export.addEventListener('click', () => {
  const lines = state.view.map(e => e.dev === 'mark'
    ? `----- ${e.msg} ${clock(e.ts)} -----`
    : `${new Date(e.ts).toISOString()} ${devName(e.dev)} ${e.lvl} ${procOf(e)}[${e.pid}] ${e.tag}: ${e.msg}`);
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const d = new Date();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mobile-logs-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

el.more.addEventListener('click', () => {
  const before = el.list.scrollHeight;
  state.limit += PAGE;
  state.stick = false;
  renderAll();
  el.list.scrollTop = el.list.scrollHeight - before;
});

el.list.addEventListener('scroll', () => {
  const atBottom = el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 30;
  if (atBottom && !state.stick) {
    state.stick = true;
    state.unseen = 0;
    el.jump.hidden = true;
    if (state.limit > PAGE) { state.limit = PAGE; renderAll(); }
  } else if (!atBottom) state.stick = false;
});
el.jump.addEventListener('click', () => {
  state.stick = true; state.unseen = 0; el.jump.hidden = true;
  if (state.limit > PAGE) { state.limit = PAGE; renderAll(); } else toBottom();
});

el.crashes.addEventListener('click', () => {
  const rows = [...el.rows.querySelectorAll('.row.crash')];
  if (!rows.length) {
    if (state.limit >= state.view.length) return;
    state.limit = state.view.length;
    renderAll();
    return el.crashes.click();
  }
  state.crashCursor = (state.crashCursor + 1) % rows.length;
  state.stick = false;
  rows[state.crashCursor].scrollIntoView({ block: 'center' });
  rows[state.crashCursor].classList.remove('flash');
  void rows[state.crashCursor].offsetWidth;
  rows[state.crashCursor].classList.add('flash');
});

let lastLevel = 'V';
document.addEventListener('keydown', ev => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target.closest('input, select, textarea')) return;
  const k = ev.key;
  if (k === '/') { ev.preventDefault(); el.q.focus(); el.q.select(); }
  else if (k === 'p') togglePause();
  else if (k === 'm') mark(false);
  else if (k === 'M') mark(true);
  else if (k === 'c') post('/api/clear', {});
  else if (k === 'w') toggleWrap();
  else if (k === 'e') {
    if (prefs.minLevel === 'E') setLevel(lastLevel);
    else { lastLevel = prefs.minLevel; setLevel('E'); }
  } else if (k === 'G' || k === 'End') el.jump.click();
});

// ---------- boot ----------
el.q.value = prefs.q;
el.qclear.hidden = !prefs.q;
el.appOnly.checked = prefs.appOnly;
el.hideSystem.checked = prefs.hideSystem;
el.wrap.setAttribute('aria-pressed', prefs.wrap);
document.body.classList.toggle('wrap', prefs.wrap);
compile(prefs.q);
renderLevels();
renderDevices();
renderEmpty();
connect();
