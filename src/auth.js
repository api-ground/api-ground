// Accounts (email + password, email code, Google), bearer-token sessions, cloud sync and shared chats, stored in D1.
import { sendEmail, mailConfigured, welcomeEmail, codeEmail, pickLang } from './mail.js';
const enc = new TextEncoder();
const DAY = 86400000;
const SESSION_TTL = 30 * DAY;
const CODE_TTL = 10 * 60 * 1000;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const now = () => Date.now();

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, avatar TEXT, google_sub TEXT UNIQUE, apple_sub TEXT UNIQUE, created_at INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, client TEXT, created_at INTEGER, expires_at INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, code_hash TEXT, expires_at INTEGER, attempts INTEGER, sent_at INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, provider TEXT, client TEXT, nonce TEXT, created_at INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS user_data (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER, PRIMARY KEY (user_id, key))'),
      db.prepare('CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, data TEXT, created_at INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS download_tokens (token TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, email TEXT, file TEXT, created_at INTEGER)'),
    ]).then(async () => {
      // Columns added after the first release; ALTER fails harmlessly when they already exist.
      for (const col of ['email_verified INTEGER DEFAULT 0', 'password_hash TEXT', 'last_seen_at INTEGER']) {
        try { await db.prepare('ALTER TABLE users ADD COLUMN ' + col).run(); } catch {}
      }
    }).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------- passwords (PBKDF2, kept modest for the Workers CPU budget) ----------
const PBKDF2_ITER = 30000;
async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return 'pbkdf2$' + PBKDF2_ITER + '$' + b64url(salt) + '$' + b64url(bits);
}
async function checkPassword(password, stored) {
  const [, iter, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash || Number(iter) !== PBKDF2_ITER) return false;
  const again = await hashPassword(password, fromB64url(salt));
  return again.split('$')[3] === hash;
}

const isLocal = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const emailEnabled = (env, url) => mailConfigured(env) || isLocal(url);

// Welcome mail for brand-new accounts; sent in the background so sign-up never waits on it.
function sendWelcome(env, url, ctx, user, lang) {
  if (!user?.email || !mailConfigured(env)) return;
  const msg = welcomeEmail({ app: env.APP_NAME || 'API-Ground', origin: url.origin, email: user.email, name: user.name, lang: pickLang(lang) });
  const job = sendEmail(env, { to: user.email, ...msg }).catch((e) => console.log('welcome email failed:', e.message));
  if (ctx?.waitUntil) ctx.waitUntil(job);
}

export function authConfig(env, url) {
  return {
    enabled: Boolean(env.DB),
    password: Boolean(env.DB),
    email: Boolean(env.DB) && emailEnabled(env, url),
    google: Boolean(env.DB && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    devEmail: Boolean(env.DB) && !mailConfigured(env) && isLocal(url),
  };
}

function publicUser(u, env) {
  return {
    id: u.id, email: u.email, name: u.name || '', avatar: u.avatar || '',
    providers: [u.google_sub && 'google', u.apple_sub && 'apple', u.password_hash && 'password', u.email_verified && 'email'].filter(Boolean),
    verified: Boolean(u.email_verified),
  };
}

async function createSession(db, userId, client) {
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, client, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, client || 'web', now(), now() + SESSION_TTL).run();
  return token;
}

export async function currentUser(env, request) {
  if (!env.DB) return null;
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+([\w-]{20,})$/);
  if (!m) return null;
  await ensureSchema(env.DB);
  const tokenHash = await sha256(m[1]);
  const row = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(tokenHash, now()).first();
  if (row) row._tokenHash = tokenHash;
  if (row && (!row.last_seen_at || now() - row.last_seen_at > 5 * 60 * 1000)) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now(), row.id).run();
  }
  return row || null;
}

async function requireUser(env, request) {
  const u = await currentUser(env, request);
  if (!u) throw new AuthError('로그인이 필요합니다.', 401);
  return u;
}

// verified: the email was proven by Google/Apple/email code. A verified login that lands on an
// unverified (password-only) account with the same email takes it over and invalidates the password,
// so nobody can pre-register someone else's address.
async function upsertUser(db, { email, name, avatar, googleSub, appleSub, verified }) {
  let user = null;
  if (googleSub) user = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(googleSub).first();
  if (!user && appleSub) user = await db.prepare('SELECT * FROM users WHERE apple_sub = ?').bind(appleSub).first();
  if (!user && email) user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (user) {
    if (verified && !user.email_verified && user.password_hash) {
      await db.batch([
        db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').bind(user.id),
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      ]);
    }
    await db.prepare('UPDATE users SET name = COALESCE(NULLIF(name, \'\'), ?), avatar = COALESCE(?, avatar), google_sub = COALESCE(google_sub, ?), apple_sub = COALESCE(apple_sub, ?), email = COALESCE(email, ?), email_verified = MAX(COALESCE(email_verified, 0), ?) WHERE id = ?')
      .bind(name || '', avatar || null, googleSub || null, appleSub || null, email || null, verified ? 1 : 0, user.id).run();
    return db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  }
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, email, name, avatar, google_sub, apple_sub, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, email || null, name || '', avatar || null, googleSub || null, appleSub || null, now(), verified ? 1 : 0).run();
  const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  created._created = true;
  return created;
}

// ---------- email + password ----------
// Email-first login (like other AI apps): tells the client whether to ask for a password or offer sign-up.
async function emailCheck(env, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AuthError('올바른 이메일 주소를 입력하세요.');
  const u = await env.DB.prepare('SELECT password_hash, google_sub FROM users WHERE email = ?').bind(email).first();
  return { exists: Boolean(u), hasPassword: Boolean(u?.password_hash), google: Boolean(u?.google_sub) };
}

async function passwordSignup(env, body, client, url, ctx) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email)) throw new AuthError('올바른 이메일 주소를 입력하세요.');
  if (password.length < 8) throw new AuthError('비밀번호는 8자 이상이어야 합니다.');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) throw new AuthError('이미 가입된 이메일입니다. 로그인하세요.', 409);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, email, name, created_at, email_verified, password_hash) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(id, email, String(body.name || '').slice(0, 60), now(), await hashPassword(password)).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  sendWelcome(env, url, ctx, user, body.lang);
  return { token: await createSession(env.DB, id, client), user: publicUser(user, env) };
}

async function passwordLogin(env, body, client) {
  const email = String(body.email || '').trim().toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !user.password_hash || !(await checkPassword(String(body.password || ''), user.password_hash))) {
    throw new AuthError('이메일 또는 비밀번호가 올바르지 않습니다.', 401);
  }
  return { token: await createSession(env.DB, user.id, client), user: publicUser(user, env) };
}

async function setPassword(env, user, body) {
  const password = String(body.password || '');
  if (password.length < 8) throw new AuthError('비밀번호는 8자 이상이어야 합니다.');
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), user.id).run();
  return { ok: true };
}

// ---------- email code ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

async function emailStart(env, url, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AuthError('올바른 이메일 주소를 입력하세요.');
  if (!emailEnabled(env, url)) throw new AuthError('이메일 발송이 설정되지 않았습니다.', 501);
  const prev = await env.DB.prepare('SELECT sent_at FROM email_codes WHERE email = ?').bind(email).first();
  if (prev && now() - prev.sent_at < 30000) throw new AuthError('잠시 후 다시 시도하세요.', 429);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await env.DB.prepare('INSERT OR REPLACE INTO email_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)')
    .bind(email, await sha256(email + ':' + code), now() + CODE_TTL, now()).run();
  if (mailConfigured(env)) {
    try {
      await sendEmail(env, { to: email, ...codeEmail({ app: env.APP_NAME || 'API-Ground', code, lang: pickLang(body.lang) }) });
    } catch (e) {
      throw new AuthError('이메일을 보내지 못했습니다: ' + e.message, 502);
    }
    return { ok: true };
  }
  // Local development without an email provider: hand the code back so the flow can be tested.
  return { ok: true, devCode: code };
}

async function emailVerify(env, body, client, url, ctx) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const row = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ?').bind(email).first();
  if (!row || row.expires_at < now()) throw new AuthError('코드가 만료되었습니다. 다시 요청하세요.');
  if (row.attempts >= 5) throw new AuthError('시도 횟수를 초과했습니다. 코드를 다시 요청하세요.', 429);
  if (row.code_hash !== await sha256(email + ':' + code)) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    throw new AuthError('코드가 올바르지 않습니다.');
  }
  await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
  const user = await upsertUser(env.DB, { email, name: String(body.name || '').slice(0, 60), verified: true });
  if (user._created) sendWelcome(env, url, ctx, user, body.lang);
  return { token: await createSession(env.DB, user.id, client), user: publicUser(user, env) };
}

// ---------- OAuth (Google) ----------
function decodeJwtPayload(jwt) {
  return JSON.parse(new TextDecoder().decode(fromB64url(jwt.split('.')[1])));
}

async function oauthStart(env, url, provider) {
  const cfg = authConfig(env, url);
  if (!cfg[provider]) throw new AuthError(provider + ' 로그인이 설정되지 않았습니다.', 501);
  const client = ['desktop', 'site'].includes(url.searchParams.get('client')) ? url.searchParams.get('client') : 'web';
  const nonce = (url.searchParams.get('nonce') || '').replace(/[^\w-]/g, '').slice(0, 64);
  const state = randomToken(24);
  await env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now() - 15 * 60 * 1000).run();
  await env.DB.prepare('INSERT INTO oauth_states (state, provider, client, nonce, created_at) VALUES (?, ?, ?, ?, ?)').bind(state, provider, client, nonce, now()).run();
  const redirect = url.origin + '/api/auth/' + provider + '/callback';
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}

async function oauthCallback(env, url, request, provider, ctx) {
  let params = url.searchParams;
  if (request.method === 'POST') params = new URLSearchParams(await request.text());
  if (params.get('error')) return finishPage(env, url, null, 'web', '', '로그인이 취소되었습니다.');
  const state = params.get('state') || '';
  const st = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').bind(state, provider).first();
  if (!st || now() - st.created_at > 15 * 60 * 1000) return finishPage(env, url, null, 'web', '', '로그인 요청이 만료되었습니다. 다시 시도하세요.');
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  const code = params.get('code');
  const redirect = url.origin + '/api/auth/' + provider + '/callback';
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const data = await res.json();
  if (!res.ok || !data.id_token) return finishPage(env, url, null, st.client, st.nonce, 'Google 로그인 실패: ' + (data.error_description || data.error || res.status));
  const p = decodeJwtPayload(data.id_token); // received directly from Google over TLS
  if (p.aud !== env.GOOGLE_CLIENT_ID) return finishPage(env, url, null, st.client, st.nonce, 'Google 토큰이 올바르지 않습니다.');
  const profile = { googleSub: p.sub, email: p.email_verified ? String(p.email).toLowerCase() : null, name: p.name, avatar: p.picture, verified: Boolean(p.email_verified) };
  const user = await upsertUser(env.DB, profile);
  if (user._created) sendWelcome(env, url, ctx, user, request.headers.get('Accept-Language'));
  const token = await createSession(env.DB, user.id, st.client);
  return finishPage(env, url, token, st.client, st.nonce);
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function finishPage(env, url, token, client, nonce, error) {
  const appName = env.APP_NAME || 'API-Ground';
  let target = '/app';
  if (token) target = client === 'desktop' ? 'apiground://auth/' + token + '?n=' + encodeURIComponent(nonce || '') : client === 'site' ? '/#auth=' + token : '/app#/auth/' + token;
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(appName) + '</title>'
    + '<style>body{font-family:system-ui,sans-serif;background:#f7f8f7;color:#1a1f1b;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}a{display:inline-block;margin-top:16px;background:#17a34a;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none}</style></head><body><main>'
    + '<img src="/img/logo.png" width="56" height="56" alt="" style="border-radius:14px">'
    + (error ? '<h2>' + esc(error) + '</h2><a href="/app">돌아가기</a>'
      : client === 'desktop' ? '<h2>로그인되었습니다</h2><p>API-Ground 앱으로 돌아가는 중입니다. 앱이 열리지 않으면 아래 버튼을 누르세요.</p><a href="' + esc(target) + '">앱 열기</a>'
        : '<h2>로그인되었습니다</h2><p>잠시만 기다려 주세요…</p>')
    + '</main>' + (error ? '' : '<script>location.replace(' + JSON.stringify(target) + ')</script>') + '</body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// ---------- sync ----------
const MAX_VALUE = 1_500_000;

async function syncPull(env, user) {
  const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM user_data WHERE user_id = ?').bind(user.id).all();
  return { items: results.map((r) => ({ key: r.key, value: r.value == null ? null : JSON.parse(r.value), updated_at: r.updated_at })) };
}

async function syncPush(env, user, body) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
  const stmts = [];
  for (const it of items) {
    const key = String(it.key || '');
    if (!/^(settings|projects|chat:[\w-]{1,64})$/.test(key)) continue;
    const value = it.value == null ? null : JSON.stringify(it.value);
    if (value && value.length > MAX_VALUE) continue;
    const at = Number(it.updated_at) || now();
    stmts.push(env.DB.prepare('INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.updated_at >= user_data.updated_at')
      .bind(user.id, key, value, at));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, saved: stmts.length };
}

// ---------- shares ----------
async function shareCreate(env, url, user, body) {
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(0, 400).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text || '').slice(0, 200000), model: m.model ? String(m.model).slice(0, 100) : undefined }));
  if (!messages.length) throw new AuthError('공유할 메시지가 없습니다.');
  const data = JSON.stringify({ title: String(body.title || '').slice(0, 200), messages });
  if (data.length > MAX_VALUE) throw new AuthError('대화가 너무 길어 공유할 수 없습니다.');
  const id = randomToken(9);
  await env.DB.prepare('INSERT INTO shares (id, user_id, title, data, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, String(body.title || '').slice(0, 200), data, now()).run();
  return { id, url: url.origin + '/share/' + id };
}

export async function sharePage(env, id) {
  if (!env.DB) return new Response('Not found', { status: 404 });
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first();
  if (!row) return new Response('공유된 대화를 찾을 수 없습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const appName = env.APP_NAME || 'API-Ground';
  const json = row.data.replace(/</g, '\\u003c');
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(row.title || '공유된 대화') + ' · ' + esc(appName) + '</title><link rel="icon" href="/img/favicon.png">'
    + '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"><link rel="stylesheet" href="/css/share.css"></head><body>'
    + '<header><a href="/" class="brand"><img src="/img/logo.png" alt="">' + esc(appName) + '</a><a class="cta" href="/app">직접 사용해 보기</a></header>'
    + '<main><h1>' + esc(row.title || '공유된 대화') + '</h1><p class="meta">' + new Date(row.created_at).toISOString().slice(0, 10) + ' · 읽기 전용 공유 링크</p><div id="msgs"></div></main>'
    + '<script id="data" type="application/json">' + json + '</script>'
    + '<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>'
    + '<script src="/js/share-page.js"></script></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
}

// ---------- desktop download (login required) ----------
export const DOWNLOAD_FILE = 'API-Ground-Setup.exe';
// The Android APK is small enough to ship with the site: scripts/build-pages.mjs copies downloads/ to /private-files/,
// which the worker hides from direct requests, so it is only reachable through a download token.
export const APK_FILE = 'API-Ground.apk';
export const PRIVATE_FILES = '/private-files/';

async function apkAvailable(env, url) {
  if (!env.ASSETS) return false;
  const r = await env.ASSETS.fetch(new Request(url.origin + PRIVATE_FILES + APK_FILE));
  r.body?.cancel();
  return r.ok;
}

async function downloadStart(env, url, user, body) {
  const platform = body?.platform === 'android' ? 'android' : 'windows';
  const token = randomToken(24);
  await env.DB.prepare('DELETE FROM download_tokens WHERE expires_at < ?').bind(now()).run();
  await env.DB.prepare('INSERT INTO download_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, user.id, now() + 10 * 60 * 1000).run();
  const available = platform === 'android' ? await apkAvailable(env, url) : Boolean(env.DOWNLOADS || env.DOWNLOAD_URL);
  return { url: url.origin + '/download/file?t=' + token + '&p=' + (platform === 'android' ? 'android' : 'win'), available };
}

export async function downloadFile(env, url) {
  if (!env.DB) return Response.redirect(url.origin + '/#download', 302);
  await ensureSchema(env.DB);
  const token = url.searchParams.get('t') || '';
  const row = await env.DB.prepare('SELECT d.user_id, u.email FROM download_tokens d LEFT JOIN users u ON u.id = d.user_id WHERE d.token = ? AND d.expires_at > ?').bind(token, now()).first();
  if (!row) return Response.redirect(url.origin + '/?login=download#download', 302);
  const android = url.searchParams.get('p') === 'android';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM download_tokens WHERE token = ?').bind(token),
    env.DB.prepare('INSERT INTO downloads (user_id, email, file, created_at) VALUES (?, ?, ?, ?)').bind(row.user_id, row.email || '', android ? APK_FILE : DOWNLOAD_FILE, now()),
  ]);
  if (android) {
    const asset = env.ASSETS && await env.ASSETS.fetch(new Request(url.origin + PRIVATE_FILES + APK_FILE));
    if (!asset?.ok) return new Response('APK 파일이 아직 업로드되지 않았습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(asset.body, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="' + APK_FILE + '"',
        'Cache-Control': 'private, no-store',
      },
    });
  }
  if (env.DOWNLOADS) {
    const obj = await env.DOWNLOADS.get(DOWNLOAD_FILE);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/vnd.microsoft.portable-executable',
          'Content-Disposition': 'attachment; filename="' + DOWNLOAD_FILE + '"',
          'Content-Length': String(obj.size),
          'Cache-Control': 'private, no-store',
        },
      });
    }
  }
  if (env.DOWNLOAD_URL) return Response.redirect(env.DOWNLOAD_URL, 302);
  return new Response('설치 파일이 아직 업로드되지 않았습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function deleteUserData(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_data WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM shares WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM download_tokens WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
}

// ---------- router ----------
export async function handleAuth(request, env, url, ctx) {
  const path = url.pathname;
  if (path === '/api/auth/config') return Response.json(authConfig(env, url));
  if (!env.DB) throw new AuthError('이 서버에는 로그인 기능이 설정되지 않았습니다. (D1 데이터베이스 필요)', 501);
  await ensureSchema(env.DB);
  const client = request.headers.get('X-Client') === 'desktop' ? 'desktop' : 'web';
  const body = ['POST', 'PATCH', 'PUT'].includes(request.method) && request.headers.get('Content-Type')?.includes('application/json') ? await request.json().catch(() => ({})) : {};

  if (path === '/api/auth/email/start' && request.method === 'POST') return Response.json(await emailStart(env, url, body));
  if (path === '/api/auth/email/verify' && request.method === 'POST') return Response.json(await emailVerify(env, body, client, url, ctx));
  if (path === '/api/auth/email/check' && request.method === 'POST') return Response.json(await emailCheck(env, body));
  if (path === '/api/auth/password/signup' && request.method === 'POST') return Response.json(await passwordSignup(env, body, client, url, ctx));
  if (path === '/api/auth/password/login' && request.method === 'POST') return Response.json(await passwordLogin(env, body, client));
  const oauth = path.match(/^\/api\/auth\/(google)\/(start|callback)$/);
  if (oauth) return oauth[2] === 'start' ? oauthStart(env, url, oauth[1]) : oauthCallback(env, url, request, oauth[1], ctx);

  const user = await requireUser(env, request);
  if (path === '/api/download' && request.method === 'POST') return Response.json(await downloadStart(env, url, user, body));
  if (path === '/api/me/password' && request.method === 'POST') return Response.json(await setPassword(env, user, body));
  if (path === '/api/me' && request.method === 'GET') return Response.json({ user: publicUser(user, env) });
  if (path === '/api/me' && request.method === 'PATCH') {
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(String(body.name || '').slice(0, 60), user.id).run();
    return Response.json({ ok: true });
  }
  if (path === '/api/me' && request.method === 'DELETE') {
    await deleteUserData(env, user.id);
    return Response.json({ ok: true });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return Response.json({ ok: true });
  }
  if (path === '/api/sync' && request.method === 'GET') return Response.json(await syncPull(env, user));
  if (path === '/api/sync' && request.method === 'POST') return Response.json(await syncPush(env, user, body));
  if (path === '/api/share' && request.method === 'POST') return Response.json(await shareCreate(env, url, user, body));
  const del = path.match(/^\/api\/share\/([\w-]+)$/);
  if (del && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM shares WHERE id = ? AND user_id = ?').bind(del[1], user.id).run();
    return Response.json({ ok: true });
  }
  throw new AuthError('Not Found', 404);
}
