#!/usr/bin/env node
// Mobile log viewer: streams Android logcat and iOS device/simulator logs to a local web page.
// Zero dependencies (Node 18+). Listens on 127.0.0.1 only, because logs can carry tokens and personal data.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
const config = loadConfig();
const PORT = Number(process.env.PORT || config.port || 7799);
const HOST = '127.0.0.1';
const BUFFER = config.bufferPerDevice || 20000;
// Devices the user chose to forget, e.g. a phone still paired over Wi-Fi. Kept in config.local.json.
const ignored = new Set(config.ignoreDevices || []);
// idevicesyslog can stay alive yet stop delivering (after a reinstall, sleep or Wi-Fi drop); restart it when quiet.
const IOS_QUIET_MS = 45_000;

// Minimal .env reader (KEY=value per line, # comments, optional quotes). Real environment variables win.
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function loadConfig() {
  const base = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const local = path.join(ROOT, 'config.local.json');
  if (existsSync(local)) Object.assign(base, JSON.parse(readFileSync(local, 'utf8')));
  // App process names: MLOG_ANDROID_APPS / MLOG_IOS_APPS (comma separated) override the config files.
  const list = v => v.split(',').map(s => s.trim()).filter(Boolean);
  base.apps = { android: [], ios: [], ...base.apps };
  if (process.env.MLOG_ANDROID_APPS !== undefined) base.apps.android = list(process.env.MLOG_ANDROID_APPS);
  if (process.env.MLOG_IOS_APPS !== undefined) base.apps.ios = list(process.env.MLOG_IOS_APPS);
  return base;
}

// ---------- tools ----------
function findTool(name, extra = []) {
  const dirs = [...(process.env.PATH || '').split(':'), ...extra];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
  return null;
}
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
const tools = {
  adb: config.adbPath || findTool('adb', [path.join(sdk, 'platform-tools')]),
  idevicesyslog: findTool('idevicesyslog', ['/opt/homebrew/bin', '/usr/local/bin']),
  idevice_id: findTool('idevice_id', ['/opt/homebrew/bin', '/usr/local/bin']),
  ideviceinfo: findTool('ideviceinfo', ['/opt/homebrew/bin', '/usr/local/bin']),
  xcrun: findTool('xcrun', ['/usr/bin']),
};

function run(cmd, args, timeout = 6000) {
  return new Promise(resolve => {
    if (!cmd) return resolve(null);
    execFile(cmd, args, { timeout, maxBuffer: 32 << 20 }, (err, stdout) => resolve(err && !stdout ? null : stdout));
  });
}

// ---------- state ----------
const devices = new Map(); // id -> device
let seq = 0;
let outbox = [];
const clients = new Set();

function publicDevice(d) {
  return {
    id: d.id, platform: d.platform, name: d.name, model: d.model, connected: d.connected,
    streaming: !!d.child, wantStream: d.wantStream, mode: d.mode, error: d.error, count: d.count, note: d.note,
  };
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
const broadcastDevices = () => broadcast('devices', [...devices.values()].map(publicDevice));

setInterval(() => {
  if (!outbox.length) return;
  const batch = outbox; outbox = [];
  broadcast('logs', batch);
}, 50);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

function emit(dev, e) {
  e.seq = ++seq;
  e.dev = dev.id;
  dev.buffer.push(e);
  if (dev.buffer.length > BUFFER) dev.buffer.splice(0, Math.ceil(BUFFER / 10));
  dev.count++;
  dev.lastTs = e.ts;
  outbox.push(e);
}

// Consecutive lines from one log call (stack traces, OkHttp blocks, iOS multi-line messages) become one entry.
function push(dev, e, key) {
  const p = dev.pending;
  if (p && key && p.key === key && e.ts - p.lastTs <= 15 && p.n < 800) {
    p.e.msg += '\n' + e.msg; p.n++; p.lastTs = e.ts;
  } else {
    flush(dev);
    dev.pending = { e, key, n: 1, lastTs: e.ts };
  }
  clearTimeout(dev.pendingTimer);
  dev.pendingTimer = setTimeout(() => flush(dev), 40);
}
function appendContinuation(dev, text) {
  if (!dev.pending) return push(dev, { ts: Date.now(), lvl: 'I', proc: '', pid: 0, tid: 0, tag: '', msg: text }, null);
  dev.pending.e.msg += '\n' + text;
  clearTimeout(dev.pendingTimer);
  dev.pendingTimer = setTimeout(() => flush(dev), 40);
}
function flush(dev) {
  if (!dev.pending) return;
  stitch(dev, dev.pending.e);
  dev.pending = null;
}

// The iOS app splits long bodies into "… | part k/N" messages (os_log truncates long ones). Join them back into one
// entry so the JSON can be read whole. Parts that never complete are released after 3 s as they are.
const PART = /^([^\n]*?) \| part (\d+)\/(\d+)(?:\n([\s\S]*))?$/;
function stitch(dev, e) {
  const m = PART.exec(e.msg);
  if (!m) return emit(dev, e);
  const [, head, k, n, body = ''] = m;
  const index = Number(k), total = Number(n);
  if (total === 1) { e.msg = `${head}\n${body}`; return emit(dev, e); }
  const key = `${e.pid}|${head}`;
  let group = dev.parts.get(key);
  if (index === 1 && group) releaseParts(dev, key);
  if (index === 1) {
    group = { e, bodies: [], total, timer: setTimeout(() => releaseParts(dev, key), 3000) };
    dev.parts.set(key, group);
  }
  if (!group) return emit(dev, e);
  group.bodies[index - 1] = body;
  if (index === total) releaseParts(dev, key);
}
function releaseParts(dev, key) {
  const group = dev.parts.get(key);
  if (!group) return;
  dev.parts.delete(key);
  clearTimeout(group.timer);
  const got = group.bodies.filter(b => b !== undefined).length;
  const head = PART.exec(group.e.msg)[1];
  group.e.msg = `${head} | ${got === group.total ? `${group.total} parts` : `${got} of ${group.total} parts`}\n${group.bodies.join('')}`;
  emit(dev, group.e);
}

// ---------- Android ----------
const LOGCAT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFAS])\s(.*?):(?: (.*))?$/;

function parseLogcat(dev, line) {
  const m = LOGCAT.exec(line);
  if (!m) {
    if (line.startsWith('--------- ')) return;
    return appendContinuation(dev, line);
  }
  const [, date, time, pid, tid, lvl, tag, msg = ''] = m;
  const p = Number(pid);
  const proc = dev.pids.get(p);
  if (!proc && p > 0) refreshPids(dev, 300);
  const level = lvl === 'A' ? 'F' : lvl === 'S' ? 'V' : lvl;
  const t = tag.trim();
  push(dev, { ts: new Date(`${date}T${time}`).getTime(), lvl: level, proc: proc || '', pid: p, tid: Number(tid), tag: t, msg },
    `${pid}|${tid}|${level}|${t}`);
}

function refreshPids(dev, delay = 0) {
  if (dev.pidTimer) return;
  dev.pidTimer = setTimeout(async () => {
    const out = await run(tools.adb, ['-s', dev.serial, 'shell', 'ps', '-A', '-o', 'PID,NAME']);
    dev.pidTimer = null;
    if (!out) return;
    const added = {};
    for (const row of out.split('\n').slice(1)) {
      const m = /^\s*(\d+)\s+(\S+)/.exec(row);
      if (!m) continue;
      const pid = Number(m[1]);
      if (dev.pids.get(pid) !== m[2]) { dev.pids.set(pid, m[2]); added[pid] = m[2]; }
    }
    if (Object.keys(added).length) broadcast('procs', { dev: dev.id, map: added });
  }, delay);
}

function androidCommand(dev) {
  const since = dev.lastTs ? ['-T', ((dev.lastTs + 1) / 1000).toFixed(3)] : ['-T', String(config.androidBacklog || 1000)];
  return { cmd: tools.adb, args: ['-s', dev.serial, 'logcat', '-v', 'threadtime,year', ...since], parse: parseLogcat };
}

// ---------- iOS device ----------
const SYSLOG = /^([A-Z][a-z]{2}\s+\d+ \d{2}:\d{2}:\d{2}(?:\.\d+)?) (.+?)\[(\d+)\] <(\w+)>: ?(.*)$/;
const IOS_LEVEL = { Debug: 'D', Info: 'I', Notice: 'I', Warning: 'W', Error: 'E', Fault: 'F', Critical: 'F', Alert: 'F', Emergency: 'F' };

function parseSyslog(dev, line) {
  if (/^\[(connected|disconnected)/.test(line)) return;
  const m = SYSLOG.exec(line);
  if (!m) return appendContinuation(dev, line);
  const [, stamp, procPart, pid, level, msg] = m;
  const pm = /^(.*?)(?:\((.*)\))?$/.exec(procPart);
  const ts = Date.parse(stamp.replace(/^(\w{3}\s+\d+) /, `$1 ${new Date().getFullYear()} `)) || Date.now();
  const lvl = IOS_LEVEL[level] || 'I';
  push(dev, { ts, lvl, proc: pm[1], pid: Number(pid), tid: 0, tag: pm[2] || '', msg }, null);
}

function iosCommand(dev) {
  const args = ['-u', dev.udid, '--no-colors'];
  if (dev.network) args.push('-n');
  // App mode with no iOS apps configured falls back to the whole device.
  const apps = config.apps.ios;
  if (dev.mode === 'app' && apps.length) args.push('-p', apps.join('|'));
  else args.push('-q');
  return { cmd: tools.idevicesyslog, args, parse: parseSyslog };
}

// ---------- iOS simulator ----------
const SIM_LEVEL = { Debug: 'D', Info: 'I', Default: 'I', Error: 'E', Fault: 'F' };
function parseSimLog(dev, line) {
  if (!line.startsWith('{')) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (!j.eventMessage && j.eventMessage !== '') return;
  const proc = path.basename(j.processImagePath || '') || '';
  const tag = [j.subsystem, j.category].filter(Boolean).join(' · ');
  push(dev, {
    ts: Date.parse(String(j.timestamp).replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) || Date.now(),
    lvl: SIM_LEVEL[j.messageType] || 'I', proc, pid: j.processID || 0, tid: j.threadID || 0, tag, msg: j.eventMessage,
  }, null);
}
function simCommand(dev) {
  const args = ['simctl', 'spawn', dev.udid, 'log', 'stream', '--style', 'ndjson', '--level', 'debug'];
  if (dev.mode === 'app') {
    const names = config.apps.ios.map(n => `process == "${n.replace(/"/g, '')}"`).join(' OR ');
    if (names) args.push('--predicate', names);
  }
  return { cmd: tools.xcrun, args, parse: parseSimLog };
}

// ---------- stream lifecycle ----------
function commandFor(dev) {
  return dev.platform === 'android' ? androidCommand(dev) : dev.platform === 'ios' ? iosCommand(dev) : simCommand(dev);
}

function start(dev) {
  if (dev.child || !dev.connected) return;
  const spec = commandFor(dev);
  if (!spec.cmd) { dev.error = 'tool not installed'; return broadcastDevices(); }
  const child = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  dev.child = child;
  dev.error = null;
  let stderr = '';
  dev.lastOutput = Date.now();
  readline.createInterface({ input: child.stdout }).on('line', line => { dev.lastOutput = Date.now(); spec.parse(dev, line); });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-400); });
  child.on('error', err => { stderr = err.message; });
  child.on('exit', code => {
    if (dev.child !== child) return;
    dev.child = null;
    flush(dev);
    clearInterval(dev.pidPoll);
    if (dev.wantStream && dev.connected) {
      if (!dev.restartNow) dev.error = stderr.trim().split('\n').pop() || `stream ended (${code})`;
      setTimeout(() => start(dev), dev.restartNow ? 0 : 2000);
      dev.restartNow = false;
    }
    broadcastDevices();
  });
  if (dev.platform === 'android') {
    refreshPids(dev);
    dev.pidPoll = setInterval(() => refreshPids(dev), 4000);
  }
  broadcastDevices();
}
function stop(dev) {
  dev.wantStream = false;
  dev.child?.kill('SIGTERM');
}
function restart(dev) {
  if (!dev.child) return start(dev);
  dev.restartNow = true;
  dev.child.kill('SIGTERM');
}

function upsert(id, fields) {
  let dev = devices.get(id);
  if (!dev) {
    dev = {
      id, buffer: [], count: 0, pids: new Map(), parts: new Map(), wantStream: !!config.autoStart, connected: false,
      mode: config.iosDefaultMode || 'app', ...fields,
    };
    devices.set(id, dev);
  } else Object.assign(dev, fields);
  return dev;
}

// ---------- discovery ----------
async function discoverAndroid() {
  const out = await run(tools.adb, ['devices', '-l']);
  const found = new Map();
  for (const row of (out || '').split('\n').slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(row.trim());
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3])?.[1]?.replace(/_/g, ' ') || m[1];
    found.set(`android:${m[1]}`, { platform: 'android', serial: m[1], name: model, model, state: m[2] });
  }
  return found;
}
async function discoverIos() {
  const found = new Map();
  if (!tools.idevice_id) return found;
  const [usb, net] = await Promise.all([run(tools.idevice_id, ['-l']), run(tools.idevice_id, ['-n'])]);
  const add = (list, network) => {
    for (const udid of (list || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      if (!found.has(`ios:${udid}`)) found.set(`ios:${udid}`, { platform: 'ios', udid, network, state: 'device' });
    }
  };
  add(usb, false); add(net, true);
  for (const [id, info] of found) {
    const known = devices.get(id);
    if (known?.name && known.name !== info.udid) { info.name = known.name; info.model = known.model; continue; }
    const args = ['-u', info.udid, ...(info.network ? ['-n'] : [])];
    const [name, product] = await Promise.all([
      run(tools.ideviceinfo, [...args, '-k', 'DeviceName']), run(tools.ideviceinfo, [...args, '-k', 'ProductType'])]);
    info.name = name?.trim() || info.udid;
    info.model = product?.trim() || 'iPhone';
  }
  return found;
}
async function discoverSims() {
  const found = new Map();
  if (!tools.xcrun) return found;
  const out = await run(tools.xcrun, ['simctl', 'list', 'devices', 'booted', '-j']);
  try {
    for (const list of Object.values(JSON.parse(out).devices || {})) {
      for (const s of list) if (s.state === 'Booted') {
        found.set(`sim:${s.udid}`, { platform: 'sim', udid: s.udid, name: s.name, model: 'Simulator', state: 'device' });
      }
    }
  } catch {}
  return found;
}

let discovering = false;
async function discover() {
  if (discovering) return;
  discovering = true;
  try {
    const [a, i, s] = await Promise.all([discoverAndroid(), discoverIos(), discoverSims()]);
    const found = new Map([...a, ...i, ...s]);
    let changed = false;
    for (const [id, info] of found) {
      if (ignored.has(id)) continue;
      const ready = info.state === 'device';
      const before = devices.get(id);
      const dev = upsert(id, { ...info, note: ready ? null : info.state });
      if (!before || before.connected !== ready || before.note !== dev.note) changed = true;
      dev.connected = ready;
      if (ready && dev.wantStream && !dev.child) start(dev);
    }
    for (const dev of devices.values()) {
      if (!found.has(dev.id) && dev.connected) {
        dev.connected = false; changed = true;
        dev.child?.kill('SIGTERM');
      }
    }
    if (changed) broadcastDevices();
  } finally { discovering = false; }
}

setInterval(() => {
  for (const dev of devices.values()) {
    if (dev.platform === 'ios' && dev.child && Date.now() - dev.lastOutput > IOS_QUIET_MS) restart(dev);
  }
}, 10_000).unref();

function forget(dev) {
  stop(dev);
  devices.delete(dev.id);
  ignored.add(dev.id);
  const file = path.join(ROOT, 'config.local.json');
  let local = {};
  try { local = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  local.ignoreDevices = [...ignored];
  writeFileSync(file, JSON.stringify(local, null, 2) + '\n');
}

// ---------- http ----------
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

function trusted(req) {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}
function body(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (!trusted(req)) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    return res.end(readFileSync(path.join(ROOT, 'public', file)));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ apps: config.apps, tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, !!v])) })}\n\n`);
    res.write(`event: devices\ndata: ${JSON.stringify([...devices.values()].map(publicDevice))}\n\n`);
    for (const dev of devices.values()) {
      if (dev.pids.size) res.write(`event: procs\ndata: ${JSON.stringify({ dev: dev.id, map: Object.fromEntries(dev.pids) })}\n\n`);
    }
    const backlog = [...devices.values()].flatMap(d => d.buffer).sort((x, y) => x.seq - y.seq);
    for (let i = 0; i < backlog.length; i += 2000) res.write(`event: logs\ndata: ${JSON.stringify(backlog.slice(i, i + 2000))}\n\n`);
    res.write('event: ready\ndata: {}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST') {
    const data = await body(req);
    if (url.pathname === '/api/clear') {
      for (const dev of devices.values()) if (!data.dev || data.dev === dev.id) { dev.buffer = []; dev.count = 0; }
      outbox = outbox.filter(e => data.dev && e.dev !== data.dev);
      broadcast('cleared', { dev: data.dev || null });
      broadcastDevices();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mark') {
      const e = { seq: ++seq, dev: 'mark', ts: Date.now(), lvl: 'I', proc: '', pid: 0, tid: 0, tag: 'MARK', msg: String(data.text || '').slice(0, 200) };
      outbox.push(e);
      return json(res, 200, { ok: true });
    }
    const m = /^\/api\/devices\/([^/]+)\/(stream|mode|forget)$/.exec(url.pathname);
    const dev = m && devices.get(decodeURIComponent(m[1]));
    if (dev && m[2] === 'forget') {
      forget(dev);
      broadcast('cleared', { dev: dev.id });
      broadcastDevices();
      return json(res, 200, { ok: true });
    }
    if (dev && m[2] === 'stream') {
      if (data.on) { dev.wantStream = true; dev.error = null; start(dev); } else stop(dev);
      broadcastDevices();
      return json(res, 200, publicDevice(dev));
    }
    if (dev && m[2] === 'mode' && (data.mode === 'app' || data.mode === 'all')) {
      dev.mode = data.mode;
      if (dev.wantStream) restart(dev);
      broadcastDevices();
      return json(res, 200, publicDevice(dev));
    }
  }
  json(res, 404, { error: 'not found' });
});

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Run with PORT=xxxx or stop the other viewer.` : err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Mobile log viewer on ${url}`);
  const missing = Object.entries(tools).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log(`Not found (that platform is skipped): ${missing.join(', ')}`);
  if (!process.argv.includes('--no-open')) execFile('open', [url], () => {});
});

discover();
setInterval(discover, 3000);

function shutdown() {
  for (const dev of devices.values()) { dev.wantStream = false; dev.child?.kill('SIGTERM'); }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
