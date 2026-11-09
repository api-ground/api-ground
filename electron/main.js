import { app, BrowserWindow, protocol, ipcMain, dialog, shell, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Keep data from earlier product names: copy the newest old profile once if the new one doesn't exist yet.
try {
  const appData = app.getPath('appData');
  const newDir = path.join(appData, 'API-Ground');
  const oldDir = ['API Playground', 'AI Playground'].map((n) => path.join(appData, n)).find((d) => fssync.existsSync(d));
  if (oldDir && !fssync.existsSync(newDir)) fssync.cpSync(oldDir, newDir, { recursive: true });
} catch {}

if (!app.requestSingleInstanceLock()) app.quit();

// apiground://auth/<token>?n=<nonce> — sent back by the server after Google login in the browser.
if (process.defaultApp) app.setAsDefaultProtocolClient('apiground', process.execPath, [path.resolve(process.argv[1] || '.')]);
else app.setAsDefaultProtocolClient('apiground');
let pendingDeepLink = process.argv.find((a) => a.startsWith('apiground://')) || null;

function deliverDeepLink(link) {
  const m = String(link || '').match(/^apiground:\/\/auth\/([\w-]{20,})(?:\?n=([\w%-]*))?/);
  if (!m) return;
  if (!win || win.webContents.isLoading()) { pendingDeepLink = link; return; }
  win.webContents.send('auth-token', m[1], decodeURIComponent(m[2] || ''));
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ---------- static files + the same API code the Cloudflare Worker runs ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveStatic(request) {
  let rel = decodeURIComponent(new URL(request.url).pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    return new Response(await fs.readFile(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

const workerEnv = { ASSETS: { fetch: serveStatic } };

// ---------- workspace roots the user explicitly opened ----------
const ROOTS_FILE = () => path.join(app.getPath('userData'), 'roots.json');
let allowedRoots = new Set();
function loadRoots() {
  try { allowedRoots = new Set(JSON.parse(fssync.readFileSync(ROOTS_FILE(), 'utf8'))); } catch {}
}
function saveRoots() {
  try { fssync.writeFileSync(ROOTS_FILE(), JSON.stringify([...allowedRoots])); } catch {}
}

function resolveIn(root, rel = '') {
  const r = path.resolve(String(root || ''));
  if (!allowedRoots.has(r)) throw new Error('허용되지 않은 작업 폴더입니다. Code 화면에서 폴더를 다시 열어 주세요.');
  if (!fssync.existsSync(r)) throw new Error('작업 폴더를 찾을 수 없습니다: ' + r);
  const p = path.resolve(r, String(rel || '').replace(/^[\\/]+/, ''));
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error('작업 폴더 밖의 경로는 사용할 수 없습니다: ' + rel);
  return p;
}

const toPosix = (p) => p.split(path.sep).join('/');
const IGNORE = new Set(['node_modules', '.git', '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.cache', '.turbo', 'coverage', '.idea', '.vs', '.gradle']);

async function walk(root, dirRel, out, limit) {
  let entries;
  try { entries = await fs.readdir(path.join(root, dirRel), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= limit) return;
    const rel = dirRel ? path.join(dirRel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) await walk(root, rel, out, limit);
    } else if (e.isFile()) {
      let size = 0;
      try { size = (await fs.stat(path.join(root, rel))).size; } catch {}
      out.push({ path: toPosix(rel), size });
    }
  }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------- processes ----------
const procs = new Map(); // id -> { child, command, out, readPos, running, exitCode, fg }
let procSeq = 0;

function spawnShell(cwd, command) {
  if (process.platform === 'win32') {
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ' + command],
    { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
  }
  return spawn('/bin/bash', ['-lc', command], { cwd, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

function track(cwd, command, fg) {
  const id = 'p' + (++procSeq);
  const child = spawnShell(cwd, command);
  const rec = { id, child, command, out: '', readPos: 0, running: true, exitCode: null, fg };
  const add = (d) => {
    rec.out += d.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (rec.out.length > 400000) { const cut = rec.out.length - 200000; rec.out = rec.out.slice(cut); rec.readPos = Math.max(0, rec.readPos - cut); }
  };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  rec.done = new Promise((resolve) => {
    child.on('error', (e) => { rec.out += '\n' + e.message; rec.running = false; rec.exitCode = -1; resolve(); });
    child.on('close', (code) => { rec.running = false; rec.exitCode = code; resolve(); });
  });
  procs.set(id, rec);
  return rec;
}

const tail = (s, n = 30000) => (s.length > n ? '...(앞부분 생략)\n' + s.slice(-n) : s);

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (e, ...args) => {
    if (!e.senderFrame || !e.senderFrame.url.startsWith('app://')) return { error: 'forbidden' };
    try { return { value: await fn(...args) }; } catch (err) { return { error: err.message || String(err) }; }
  });
}

function registerIpc() {
  handle('ws:pick', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { title: '작업 폴더 열기', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const root = path.resolve(r.filePaths[0]);
    allowedRoots.add(root);
    saveRoots();
    return { root, name: path.basename(root) || root };
  });
  handle('ws:list', async (root, dir) => {
    const base = resolveIn(root);
    const start = dir ? path.relative(base, resolveIn(root, dir)) : '';
    const out = [];
    await walk(base, start, out, 3000);
    return { files: out, truncated: out.length >= 3000 };
  });
  handle('ws:read', async (root, rel) => {
    const p = resolveIn(root, rel);
    let st;
    try { st = await fs.stat(p); } catch { throw new Error('File not found: ' + rel); }
    if (st.isDirectory()) throw new Error(rel + ' is a directory');
    if (st.size > 5 * 1024 * 1024) throw new Error('File is too large to read (' + Math.round(st.size / 1024) + ' KB)');
    const buf = await fs.readFile(p);
    if (isBinary(buf)) throw new Error('Binary file, cannot be read as text: ' + rel);
    return buf.toString('utf8');
  });
  handle('ws:write', async (root, rel, content) => {
    const p = resolveIn(root, rel);
    if (p === resolveIn(root)) throw new Error('Invalid path');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, String(content ?? ''), 'utf8');
    return true;
  });
  handle('ws:remove', async (root, rel) => {
    const p = resolveIn(root, rel);
    const st = await fs.stat(p).catch(() => null);
    if (!st) throw new Error('File not found: ' + rel);
    if (st.isDirectory()) throw new Error('delete_file only deletes files. Use run_command for folders.');
    await fs.unlink(p);
    return true;
  });
  handle('ws:exists', async (root, rel) => fssync.existsSync(resolveIn(root, rel)));
  handle('ws:grep', async (root, pattern, prefix) => {
    const base = resolveIn(root);
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { throw new Error('Invalid regex: ' + pattern); }
    const files = [];
    await walk(base, prefix ? path.relative(base, resolveIn(root, prefix)) : '', files, 5000);
    const hits = [];
    for (const f of files) {
      if (hits.length >= 200) break;
      if (f.size > 2 * 1024 * 1024) continue;
      let buf;
      try { buf = await fs.readFile(path.join(base, f.path)); } catch { continue; }
      if (isBinary(buf)) continue;
      buf.toString('utf8').split('\n').forEach((l, i) => { if (hits.length < 200 && re.test(l)) hits.push(f.path + ':' + (i + 1) + ': ' + l.slice(0, 300)); });
    }
    return hits;
  });
  handle('ws:reveal', async (root) => { await shell.openPath(resolveIn(root)); return true; });
  handle('app:open', async (url) => {
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(String(url))) throw new Error('Only http(s) links can be opened');
    await shell.openExternal(String(url));
    return true;
  });
  handle('app:theme', async (theme) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
    return true;
  });

  handle('proc:run', async (root, command, timeoutSec) => {
    const rec = track(resolveIn(root), String(command), true);
    const secs = Math.min(Math.max(Number(timeoutSec) || 120, 1), 600);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; killTree(rec.child); }, secs * 1000);
    await rec.done;
    clearTimeout(t);
    procs.delete(rec.id);
    return { exitCode: rec.exitCode, output: tail(rec.out), timedOut, killed: rec.killed || false };
  });
  handle('proc:start', async (root, command) => {
    const rec = track(resolveIn(root), String(command), false);
    await Promise.race([rec.done, new Promise((r) => setTimeout(r, 4000))]);
    rec.readPos = rec.out.length;
    return { id: rec.id, running: rec.running, exitCode: rec.exitCode, output: tail(rec.out, 8000) };
  });
  handle('proc:output', async (id) => {
    const rec = procs.get(id);
    if (!rec) throw new Error('No such process: ' + id);
    const out = rec.out.slice(rec.readPos);
    rec.readPos = rec.out.length;
    return { id, running: rec.running, exitCode: rec.exitCode, output: tail(out, 20000) };
  });
  handle('proc:kill', async (id) => {
    const rec = procs.get(id);
    if (!rec) throw new Error('No such process: ' + id);
    killTree(rec.child);
    await Promise.race([rec.done, new Promise((r) => setTimeout(r, 3000))]);
    procs.delete(id);
    return true;
  });
  handle('proc:killForeground', async () => {
    for (const rec of procs.values()) if (rec.fg) { rec.killed = true; killTree(rec.child); }
    return true;
  });
  handle('proc:list', async () => [...procs.values()].filter((r) => !r.fg).map((r) => ({ id: r.id, command: r.command, running: r.running, exitCode: r.exitCode })));
}

// ---------- window ----------
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
let win = null;

function createWindow() {
  let state = { width: 1320, height: 860 };
  try { state = { ...state, ...JSON.parse(fssync.readFileSync(STATE_FILE(), 'utf8')) }; } catch {}
  win = new BrowserWindow({
    ...state,
    minWidth: 420,
    minHeight: 520,
    title: 'API-Ground',
    icon: fssync.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1f1d' : '#f7f8f7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  // Safety net: never let the window get stuck hidden in the background. If the first paint doesn't fire
  // (slow or failed load), show it anyway after a short delay, and show it on a load failure too.
  const forceShow = setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 2500);
  win.once('show', () => clearTimeout(forceShow));
  win.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame && win && !win.isDestroyed() && !win.isVisible()) win.show();
  });
  win.loadURL('app://local/app.html');
  win.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) { const l = pendingDeepLink; pendingDeepLink = null; setTimeout(() => deliverDeepLink(l), 800); }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  win.on('close', () => {
    try {
      const b = win.getNormalBounds();
      fssync.writeFileSync(STATE_FILE(), JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() }));
    } catch {}
  });
}

app.on('second-instance', (e, argv) => {
  const link = argv.find((a) => a.startsWith('apiground://'));
  if (link) deliverDeepLink(link);
  // Bring the existing window back (show it even if it was stuck hidden); recreate it if it was closed.
  if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
  else createWindow();
});
app.on('open-url', (e, url) => { e.preventDefault(); deliverDeepLink(url); });

app.whenReady().then(() => {
  loadRoots();
  protocol.handle('app', (request) => worker.fetch(request, workerEnv));
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const rec of procs.values()) killTree(rec.child);
  if (process.platform !== 'darwin') app.quit();
});
