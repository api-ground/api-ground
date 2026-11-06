// Client side of accounts: login (app page, homepage modal), session token, cloud sync and share links.
import { app, persist, emit, onPersist } from './state.js';
import { h, toast, modal, copyText, confirmDialog, timeAgo, uid } from './ui.js';
import { brandImg } from './api.js';
import { t as tr, lang } from './i18n.js';

const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const auth = { token: ls.get('pg_token'), user: ls.get('pg_user'), config: null, lastSync: ls.get('pg_last_sync', 0) };

export const isLoggedIn = () => Boolean(auth.token && auth.user);
// The desktop app talks to the official site for login, sync and sharing unless the user points it elsewhere.
export const DEFAULT_SERVER = 'https://api-ground.pages.dev';
export const serverBase = () => (window.desktop ? String(app.settings.serverUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '') : '');

export async function call(path, opts = {}) {
  const base = serverBase();
  if (window.desktop && !base) throw new Error(tr('동기화 서버 주소를 먼저 입력하세요.'));
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  if (window.desktop) headers['X-Client'] = 'desktop';
  const res = await fetch(base + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth.token && !path.startsWith('/api/auth/')) signOutLocal();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

export async function loadAuthConfig() {
  if (window.desktop && !serverBase()) return (auth.config = { enabled: false, needsServer: true });
  try {
    const res = await fetch(serverBase() + '/api/auth/config');
    auth.config = res.ok ? await res.json() : { enabled: false };
  } catch {
    auth.config = { enabled: false, unreachable: Boolean(serverBase()) };
  }
  return auth.config;
}

export function needsLogin() {
  return Boolean(auth.config?.enabled) && !isLoggedIn() && !ls.get('pg_skip_login');
}

export async function setToken(token, { sync = true } = {}) {
  auth.token = token;
  ls.set('pg_token', token);
  try {
    const { user } = await call('/api/me');
    auth.user = user;
    ls.set('pg_user', user);
    ls.set('pg_skip_login', null);
    if (sync && app.settings && !app.settings.name && user.name) { app.settings.name = user.name; persist('settings'); }
    emit('auth');
    if (sync) syncNow(true).catch((e) => toast(tr('동기화 실패: ') + e.message));
    return user;
  } catch (e) {
    signOutLocal();
    throw e;
  }
}

export async function refreshUser() {
  if (!auth.token) return null;
  try {
    const { user } = await call('/api/me');
    auth.user = user;
    ls.set('pg_user', user);
    emit('auth');
    return user;
  } catch { return null; }
}

function signOutLocal() {
  auth.token = null;
  auth.user = null;
  ls.set('pg_token', null);
  ls.set('pg_user', null);
  meta = { chats: {}, settingsAt: 0, projectsAt: 0 };
  ls.set('pg_sync_meta', meta);
  emit('auth');
}

export async function signOut() {
  try { await call('/api/auth/logout', { method: 'POST' }); } catch {}
  signOutLocal();
  toast(tr('로그아웃했습니다'));
}

export async function deleteAccount() {
  if (!(await confirmDialog(tr('계정과 서버에 동기화된 모든 데이터를 삭제할까요? 이 기기의 데이터는 남습니다.'), { okLabel: tr('계정 삭제'), danger: true }))) return;
  try {
    await call('/api/me', { method: 'DELETE' });
    signOutLocal();
    toast(tr('계정을 삭제했습니다'));
  } catch (e) { toast(e.message); }
}

// ---------- sync ----------
let meta = ls.get('pg_sync_meta', { chats: {}, settingsAt: 0, projectsAt: 0 });
const dirty = new Set();
let pushTimer = null;
let syncing = false;
let applyingRemote = false;

const LOCAL_ONLY = ['keys', 'password', 'serverUrl', 'bases', 'sidebarCollapsed'];
function settingsPayload() {
  const s = { ...app.settings };
  LOCAL_ONLY.forEach((k) => delete s[k]);
  return s;
}

// Binary attachments are not synced (size limits); text stays.
function slim(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 200 ? null : k === 'streaming' ? undefined : v)));
}

const chatSig = (c) => [c.updatedAt, c.title, c.starred, c.projectId, Object.keys(c.nodes).length, JSON.stringify(c.sel)].join('|');

export function initSync() {
  onPersist((key) => {
    if (applyingRemote || !isLoggedIn() || !['settings', 'chats', 'projects'].includes(key)) return;
    dirty.add(key);
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push().catch(() => {}), 2500);
  });
  window.addEventListener('focus', () => { if (isLoggedIn() && Date.now() - auth.lastSync > 30000) syncNow(false).catch(() => {}); });
  setInterval(() => { if (isLoggedIn() && document.visibilityState === 'visible') syncNow(false).catch(() => {}); }, 120000);
}

async function push() {
  if (!isLoggedIn()) return;
  if (syncing) { pushTimer = setTimeout(() => push().catch(() => {}), 2000); return; }
  syncing = true;
  try {
    const items = [];
    const at = Date.now();
    if (dirty.has('settings')) { items.push({ key: 'settings', value: settingsPayload(), updated_at: at }); meta.settingsAt = at; }
    if (dirty.has('projects')) { items.push({ key: 'projects', value: slim(app.projects), updated_at: at }); meta.projectsAt = at; }
    if (dirty.has('chats')) {
      const ids = new Set();
      for (const c of app.chats) {
        ids.add(c.id);
        if (app.busy?.chatId === c.id) continue;
        const sig = chatSig(c);
        if (meta.chats[c.id]?.sig !== sig) { items.push({ key: 'chat:' + c.id, value: slim(c), updated_at: at }); meta.chats[c.id] = { sig, at }; }
      }
      for (const id of Object.keys(meta.chats)) {
        if (!ids.has(id)) { items.push({ key: 'chat:' + id, value: null, updated_at: at }); delete meta.chats[id]; }
      }
    }
    dirty.clear();
    for (let i = 0; i < items.length; i += 40) await call('/api/sync', { method: 'POST', body: JSON.stringify({ items: items.slice(i, i + 40) }) });
    ls.set('pg_sync_meta', meta);
    auth.lastSync = Date.now();
    ls.set('pg_last_sync', auth.lastSync);
    emit('sync');
  } finally {
    syncing = false;
  }
}

function keepLocalBinaries(local, remote) {
  for (const [id, node] of Object.entries(remote.nodes || {})) {
    const ln = local.nodes?.[id];
    if (!ln) continue;
    (node.files || []).forEach((f, i) => { if (f.data == null && ln.files?.[i]?.data) f.data = ln.files[i].data; });
    (node.parts || []).forEach((p, i) => { if (p.type === 'image' && p.data == null && ln.parts?.[i]?.data) p.data = ln.parts[i].data; });
  }
  return remote;
}

async function pull() {
  const { items } = await call('/api/sync');
  const changed = new Set();
  for (const it of items) {
    if (it.key === 'settings' && it.value && it.updated_at > meta.settingsAt) {
      const keep = Object.fromEntries(LOCAL_ONLY.map((k) => [k, app.settings[k]]));
      Object.assign(app.settings, it.value, keep);
      meta.settingsAt = it.updated_at;
      changed.add('settings');
    } else if (it.key === 'projects' && it.value && it.updated_at > meta.projectsAt) {
      const local = new Map(app.projects.map((p) => [p.id, p]));
      app.projects = it.value.map((p) => {
        const lp = local.get(p.id);
        if (lp) p.files = (p.files || []).map((f) => (f.data == null ? lp.files?.find((x) => x.name === f.name && x.data) || f : f));
        return p;
      });
      meta.projectsAt = it.updated_at;
      changed.add('projects');
    } else if (it.key.startsWith('chat:')) {
      const id = it.key.slice(5);
      const lm = meta.chats[id];
      const idx = app.chats.findIndex((c) => c.id === id);
      if (it.value == null) {
        if (idx >= 0 && (!lm || it.updated_at >= lm.at) && app.busy?.chatId !== id) { app.chats.splice(idx, 1); changed.add('chats'); }
        delete meta.chats[id];
      } else if (!lm || it.updated_at > lm.at) {
        if (app.busy?.chatId === id) continue;
        const chat = idx >= 0 ? keepLocalBinaries(app.chats[idx], it.value) : it.value;
        if (idx >= 0) app.chats[idx] = chat; else app.chats.push(chat);
        meta.chats[id] = { sig: chatSig(chat), at: it.updated_at };
        changed.add('chats');
      }
    }
  }
  if (changed.size) {
    app.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    applyingRemote = true;
    try { changed.forEach((k) => persist(k)); } finally { applyingRemote = false; }
    changed.forEach((k) => emit(k));
  }
  ls.set('pg_sync_meta', meta);
  return changed;
}

export async function syncNow(initial) {
  if (!isLoggedIn()) return;
  await pull();
  if (initial) { dirty.add('settings'); dirty.add('projects'); }
  dirty.add('chats');
  await push();
}

// ---------- share ----------
export async function shareChat(chat, messages) {
  if (!isLoggedIn()) {
    toast(tr('공유 링크를 만들려면 로그인하세요'));
    location.hash = '#/login';
    return;
  }
  try {
    const res = await call('/api/share', { method: 'POST', body: JSON.stringify({ title: chat.title, messages }) });
    const input = h('input', { type: 'text', readonly: true, value: res.url });
    modal(tr('공유 링크'), h('div', { class: 'form' },
      h('p', { class: 'muted' }, tr('링크가 있는 누구나 이 대화의 현재 내용을 읽을 수 있습니다. 첨부 파일은 포함되지 않습니다.')),
      h('div', { class: 'share-row' }, input, h('button', { class: 'btn primary', onclick: () => copyText(res.url, tr('링크를 복사했습니다')) }, tr('복사')))), {
      actions: [{ label: tr('닫기') }, { label: tr('열기'), onClick: () => { window.open(res.url, '_blank'); } }],
    });
    setTimeout(() => input.select(), 50);
  } catch (e) { toast(e.message); }
}

// ---------- login card (used by the app page and the homepage modal) ----------

// Android/iOS app (Capacitor shell loading this site). Google blocks sign-in inside app web views,
// so OAuth runs in the system browser and returns through apiground://auth/<token>?n=<nonce>.
const mobile = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const NONCE_KEY = 'apiground.oauthNonce';
let pendingNonce = null;
let desktopDone = null;

function savedNonce() {
  if (pendingNonce) return pendingNonce;
  try { return localStorage.getItem(NONCE_KEY); } catch { return null; }
}
function setNonce(v) {
  pendingNonce = v;
  try { v ? localStorage.setItem(NONCE_KEY, v) : localStorage.removeItem(NONCE_KEY); } catch {}
}

async function receiveToken(token, nonce) {
  const expected = savedNonce();
  if (!expected || nonce !== expected) { toast(tr('로그인 요청을 확인할 수 없습니다. 다시 시도하세요.')); return; }
  setNonce(null);
  try {
    const user = await setToken(token);
    toast(tr('로그인되었습니다'));
    (desktopDone || defaultDone)(user);
  } catch (e) { toast(e.message); }
}

function handleMobileUrl(url) {
  const m = String(url || '').match(/^apiground:\/\/auth\/([\w-]+)(?:\?n=([\w%-]*))?/);
  if (!m) return;
  mobile.Plugins.Browser?.close?.().catch(() => {});
  receiveToken(m[1], decodeURIComponent(m[2] || ''));
}

export function initDesktopAuth() {
  window.desktop?.onAuthToken?.(receiveToken);
  if (mobile) {
    mobile.Plugins.App?.addListener?.('appUrlOpen', (e) => handleMobileUrl(e.url));
    mobile.Plugins.App?.getLaunchUrl?.().then((r) => r?.url && handleMobileUrl(r.url)).catch(() => {});
  }
}

function defaultDone() {
  location.hash = '#/';
}

function startOAuth(provider, oauthClient, onDone) {
  const base = serverBase();
  if (window.desktop || mobile) {
    setNonce(uid() + uid());
    desktopDone = onDone;
    const startUrl = (base || location.origin) + '/api/auth/' + provider + '/start?client=desktop&nonce=' + encodeURIComponent(pendingNonce);
    if (window.desktop) window.desktop.openExternal(startUrl);
    else mobile.Plugins.Browser.open({ url: startUrl });
    toast(tr('브라우저에서 로그인을 완료하면 앱으로 돌아옵니다'));
  } else {
    location.href = '/api/auth/' + provider + '/start' + (oauthClient ? '?client=' + oauthClient : '');
  }
}

// opts: { onDone(user), oauthClient: 'site'|undefined, sync: boolean, subtitle }
export function loginCard(opts = {}) {
  const onDone = opts.onDone || defaultDone;
  const body = h('div', { class: 'login-body' });
  const card = h('div', { class: 'login-card' },
    h('img', { src: '/img/logo.png', class: 'login-logo', alt: '' }),
    h('h1', {}, 'API-Ground'),
    h('p', { class: 'muted center' }, opts.subtitle || tr('Claude, GPT, Gemini, Grok… 여러 AI를 한곳에서')),
    body,
    h('p', { class: 'legal' }, tr('계속하면 서비스 이용약관과 개인정보 처리방침에 동의하게 됩니다.')));

  const finish = async (token) => {
    const user = await setToken(token, { sync: opts.sync !== false });
    toast(tr('로그인되었습니다'));
    onDone(user);
  };

  const field = (attrs) => h('input', attrs);
  const primary = (label) => h('button', { class: 'btn primary block' }, label);
  const back = () => h('button', { class: 'btn ghost block', onclick: start }, tr('다른 방법으로 로그인'));
  const emailChip = (email) => h('div', { class: 'email-chip' }, h('span', {}, email), h('button', { class: 'link-btn', onclick: start }, tr('변경')));

  const oauthButtons = (cfg) => {
    const els = [];
    if (cfg.google) els.push(h('button', { class: 'btn oauth block', onclick: () => startOAuth('google', opts.oauthClient, onDone) }, brandImg('google', 18), tr('Google로 계속하기')));
    return els;
  };

  const serverForm = () => {
    const input = field({ type: 'url', placeholder: 'https://api-ground.pages.dev', value: app.settings.serverUrl || '' });
    return h('div', { class: 'login-section' },
      h('p', { class: 'muted small' }, tr('서버에 연결할 수 없습니다. 주소를 확인하세요.')),
      input,
      h('button', { class: 'btn primary block', onclick: async () => {
        app.settings.serverUrl = input.value.trim();
        persist('settings');
        await loadAuthConfig();
        start();
      } }, tr('서버 연결')));
  };

  function codeStep(email, devCode) {
    const code = field({ type: 'text', inputmode: 'numeric', maxlength: 6, placeholder: '000000', class: 'code-input-6', autocomplete: 'one-time-code' });
    const btn = primary(tr('확인'));
    const verify = async () => {
      btn.disabled = true;
      try {
        const r = await call('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ email, code: code.value.trim(), name: app.settings?.name || '', lang: lang() }) });
        await finish(r.token);
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    btn.addEventListener('click', verify);
    code.addEventListener('input', () => { if (code.value.trim().length === 6) verify(); });
    body.replaceChildren(h('div', { class: 'login-section' },
      emailChip(email),
      h('p', {}, tr('{email}(으)로 6자리 코드를 보냈습니다.', { email })),
      devCode ? h('div', { class: 'notice' }, tr('개발 모드: 이메일 발송이 설정되지 않아 코드를 화면에 표시합니다 → '), h('b', {}, devCode)) : null,
      code, btn, back()));
    code.focus();
  }

  async function sendCode(email) {
    try {
      const r = await call('/api/auth/email/start', { method: 'POST', body: JSON.stringify({ email, lang: lang() }) });
      codeStep(email, r.devCode);
    } catch (e) { toast(e.message); }
  }

  function passwordStep(email, info) {
    const pw = field({ type: 'password', placeholder: tr('비밀번호'), autocomplete: 'current-password' });
    const btn = primary(tr('로그인'));
    const go = async () => {
      if (!pw.value) { pw.focus(); return; }
      btn.disabled = true;
      try {
        const r = await call('/api/auth/password/login', { method: 'POST', body: JSON.stringify({ email, password: pw.value }) });
        await finish(r.token);
      } catch (e) { toast(e.message); btn.disabled = false; pw.select(); }
    };
    btn.addEventListener('click', go);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    body.replaceChildren(h('div', { class: 'login-section' },
      emailChip(email),
      h('p', { class: 'step-title' }, tr('다시 오신 것을 환영합니다')),
      pw, btn,
      auth.config.email ? h('button', { class: 'link-btn', onclick: () => sendCode(email) }, tr('이메일 인증 코드로 로그인')) : null,
      info?.google && auth.config.google ? h('button', { class: 'link-btn', onclick: () => startOAuth('google', opts.oauthClient, onDone) }, tr('Google로 계속하기')) : null));
    pw.focus();
  }

  function oauthOnlyStep(email, info) {
    body.replaceChildren(h('div', { class: 'login-section' },
      emailChip(email),
      h('p', {}, tr('이 이메일은 Google 계정으로 가입되어 있습니다.')),
      ...oauthButtons({ google: auth.config.google }),
      auth.config.email ? h('button', { class: 'link-btn', onclick: () => sendCode(email) }, tr('이메일 인증 코드로 로그인')) : null,
      back()));
  }

  function signupStep(email) {
    const name = field({ type: 'text', placeholder: tr('이름 (선택)'), autocomplete: 'name' });
    const pw = field({ type: 'password', placeholder: tr('비밀번호 만들기 (8자 이상)'), autocomplete: 'new-password' });
    const btn = primary(tr('계정 만들기'));
    const go = async () => {
      if (pw.value.length < 8) { toast(tr('비밀번호는 8자 이상이어야 합니다.')); pw.focus(); return; }
      btn.disabled = true;
      try {
        const r = await call('/api/auth/password/signup', { method: 'POST', body: JSON.stringify({ email, password: pw.value, name: name.value.trim(), lang: lang() }) });
        if (name.value.trim() && app.settings && !app.settings.name) { app.settings.name = name.value.trim(); if (opts.sync !== false) persist('settings'); }
        await finish(r.token);
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    btn.addEventListener('click', go);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    body.replaceChildren(h('div', { class: 'login-section' },
      emailChip(email),
      h('p', { class: 'step-title' }, tr('새 계정 만들기')),
      name, pw, btn));
    name.focus();
  }

  function start() {
    const cfg = auth.config || {};
    if (cfg.needsServer || cfg.unreachable) { body.replaceChildren(serverForm()); return; }
    if (!cfg.enabled) { body.replaceChildren(h('div', { class: 'notice' }, tr('이 서버에는 로그인 기능이 설정되지 않았습니다.'))); return; }
    const email = field({ type: 'email', placeholder: tr('이메일 주소 입력'), autocomplete: 'email' });
    const btn = primary(tr('이메일로 계속하기'));
    const go = async () => {
      const v = email.value.trim();
      if (!v) { email.focus(); return; }
      btn.disabled = true;
      try {
        const info = await call('/api/auth/email/check', { method: 'POST', body: JSON.stringify({ email: v }) });
        if (info.exists && info.hasPassword) passwordStep(v, info);
        else if (info.exists && info.google) oauthOnlyStep(v, info);
        else if (info.exists && cfg.email) sendCode(v);
        else signupStep(v);
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    btn.addEventListener('click', go);
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const oauth = oauthButtons(cfg);
    body.replaceChildren(...oauth, oauth.length ? h('div', { class: 'or' }, h('span', {}, tr('또는'))) : null, h('div', { class: 'login-section' }, email, btn));
    setTimeout(() => email.focus(), 30);
  }

  start();
  return card;
}

export async function renderLogin(container) {
  if (!auth.config) await loadAuthConfig();
  container.replaceChildren(h('div', { class: 'login' },
    loginCard(),
    h('button', { class: 'skip-login', onclick: () => { ls.set('pg_skip_login', true); location.hash = '#/'; } }, tr('로그인 없이 사용하기 (이 기기에만 저장)'))));
}

// ---------- account settings tab ----------
export function accountTab() {
  const wrap = h('div', { class: 'form' });
  const draw = () => {
    const els = [];
    if (window.desktop) {
      const input = h('input', { type: 'url', value: app.settings.serverUrl || '', placeholder: 'https://api-ground.pages.dev' });
      input.addEventListener('change', async () => { app.settings.serverUrl = input.value.trim(); persist('settings'); await loadAuthConfig(); draw(); });
      els.push(h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('동기화 서버 주소')), input, h('small', { class: 'muted' }, tr('웹사이트를 배포한 주소입니다. 로그인·동기화·공유 링크에 사용됩니다.'))));
    }
    if (isLoggedIn()) {
      const u = auth.user;
      els.push(h('div', { class: 'account-card' },
        u.avatar ? h('img', { src: u.avatar, class: 'acc-avatar', alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar acc-avatar' }, (u.name || u.email || '?').slice(0, 1).toUpperCase()),
        h('div', {}, h('b', {}, u.name || u.email), h('small', { class: 'muted' }, u.email || ''), h('small', { class: 'muted' }, tr('로그인 방법: ') + (u.providers.join(', ') || '-')))));
      els.push(h('div', { class: 'setting-row' }, h('div', {}, h('b', {}, tr('동기화')), h('small', { class: 'muted' }, auth.lastSync ? tr('마지막 동기화 {when}', { when: timeAgo(auth.lastSync) }) : tr('아직 동기화하지 않았습니다'))),
        h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; try { await syncNow(true); toast(tr('동기화했습니다')); } catch (err) { toast(err.message); } draw(); } }, tr('지금 동기화'))));
      els.push(h('p', { class: 'muted small' }, tr('채팅, 프로젝트, 설정이 동기화됩니다. API 키와 이미지·PDF 첨부, Code 세션은 이 기기에만 저장됩니다.')));
      const pw = h('input', { type: 'password', placeholder: tr('새 비밀번호 (8자 이상)'), autocomplete: 'new-password' });
      els.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, u.providers.includes('password') ? tr('비밀번호 변경') : tr('비밀번호 설정')),
        h('div', { class: 'share-row' }, pw, h('button', { class: 'btn', onclick: async () => {
          try { await call('/api/me/password', { method: 'POST', body: JSON.stringify({ password: pw.value }) }); pw.value = ''; toast(tr('비밀번호를 저장했습니다')); await refreshUser(); draw(); } catch (e) { toast(e.message); }
        } }, tr('저장')))));
      els.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await signOut(); draw(); } }, tr('로그아웃')), h('button', { class: 'btn danger', onclick: async () => { await deleteAccount(); draw(); } }, tr('계정 삭제'))));
    } else {
      els.push(h('div', { class: 'account-cta' },
        h('p', {}, tr('로그인하면 채팅, 프로젝트, 설정이 여러 기기에서 동기화되고 공유 링크를 만들 수 있습니다.')),
        h('button', { class: 'btn primary', onclick: () => { document.querySelector('dialog.modal')?.close(); document.querySelector('dialog.modal')?.remove(); location.hash = '#/login'; } }, tr('로그인 또는 가입'))));
    }
    wrap.replaceChildren(...els);
  };
  draw();
  return wrap;
}
