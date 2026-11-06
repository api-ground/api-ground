import { t, LANGUAGES, langSetting, setLanguage, lang } from './i18n.js';
import { auth, isLoggedIn, loadAuthConfig, loginCard, setToken, signOut, call, refreshUser } from './account.js';
import { toast } from './ui.js';

// Text written in Korean is the translation key, as in the app.
document.querySelectorAll('[data-i18n]').forEach((el) => {
  const key = el.innerHTML.trim();
  const out = t(key);
  if (out !== key) el.innerHTML = out;
});
document.title = 'API-Ground — ' + t('모든 AI를 한곳에서');
document.documentElement.lang = lang();

const sel = document.getElementById('lang');
LANGUAGES.forEach((l) => sel.append(new Option(l.label || t('시스템 언어 따르기'), l.id)));
sel.value = langSetting();
sel.addEventListener('change', () => setLanguage(sel.value));

// Theme: the homepage keeps its own small preference (the app's settings live in IndexedDB).
const order = ['system', 'light', 'dark'];
const themeName = { system: '시스템 설정', light: '밝은 화면', dark: '어두운 화면' };
const applyTheme = (v) => {
  if (v === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
};
let theme = 'system';
try { theme = localStorage.getItem('pg_site_theme') || 'system'; } catch {}
applyTheme(theme);
const themeBtn = document.getElementById('theme');
themeBtn.title = t('화면 테마') + ': ' + t(themeName[theme]);
themeBtn.addEventListener('click', () => {
  theme = order[(order.indexOf(theme) + 1) % order.length];
  try { localStorage.setItem('pg_site_theme', theme); } catch {}
  applyTheme(theme);
  themeBtn.title = t('화면 테마') + ': ' + t(themeName[theme]);
});

const BRANDS = [
  ['claude', 'Claude'], ['openai', 'OpenAI'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['deepseek', 'DeepSeek'], ['kimi', 'Kimi'],
  ['zhipu', 'GLM'], ['qwen', 'Qwen'], ['mistral', 'Mistral'], ['minimax', 'MiniMax'], ['nvidia', 'NVIDIA NIM'], ['meta', 'Llama'],
  ['groq', 'Groq'], ['openrouter', 'OpenRouter'], ['together', 'Together AI'], ['fireworks', 'Fireworks'], ['cerebras', 'Cerebras'],
  ['sambanova', 'SambaNova'], ['huggingface', 'Hugging Face'], ['cohere', 'Cohere'], ['perplexity', 'Perplexity'],
];
const grid = document.getElementById('logoGrid');
for (const [icon, name] of BRANDS) {
  const item = document.createElement('div');
  item.className = 'logo-item';
  const img = document.createElement('img');
  img.src = '/img/brands/' + icon + '.svg';
  img.alt = '';
  if (['openai', 'grok', 'groq'].includes(icon)) img.className = 'mono';
  const span = document.createElement('span');
  span.textContent = name;
  item.append(img, span);
  grid.append(item);
}

// ---------- account ----------
const navRight = document.querySelector('.nav-right');
const loginBtn = navRight.querySelector('a[href="/app#/login"]');
let chip = null;

function goAfterLogin(user, next) {
  renderNav();
  if (next) next();
}

function openLogin({ subtitle, next } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const closeBtn = document.createElement('button');
  closeBtn.className = 'icon close';
  closeBtn.setAttribute('aria-label', t('닫기'));
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  closeBtn.addEventListener('click', close);
  if (next) { try { sessionStorage.setItem('pg_after_login', 'download'); } catch {} }
  const card = loginCard({ sync: false, oauthClient: 'site', subtitle, onDone: (user) => { close(); goAfterLogin(user, next); } });
  overlay.append(closeBtn, card);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

function renderNav() {
  chip?.remove();
  chip = null;
  if (!isLoggedIn()) { loginBtn.hidden = false; return; }
  loginBtn.hidden = true;
  const u = auth.user;
  chip = document.createElement('button');
  chip.className = 'user-chip';
  const av = document.createElement('span');
  av.className = 'av';
  if (u.avatar) { const img = document.createElement('img'); img.src = u.avatar; img.referrerPolicy = 'no-referrer'; img.alt = ''; av.append(img); } else av.textContent = (u.name || u.email || '?').slice(0, 1).toUpperCase();
  const name = document.createElement('span');
  name.className = 'hide-sm';
  name.textContent = u.name || (u.email || '').split('@')[0];
  const menu = document.createElement('div');
  menu.className = 'user-menu';
  const label = document.createElement('div');
  label.className = 'um-label';
  label.textContent = u.email || '';
  menu.append(label);
  const item = (text, fn) => { const b = document.createElement('button'); b.textContent = text; b.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); fn(); }); menu.append(b); };
  item(t('앱 열기'), () => { location.href = '/app'; });
  item(t('Windows 앱 다운로드'), () => startDownload('windows'));
  item(t('Android 앱 다운로드'), () => startDownload('android'));
  item(t('로그아웃'), async () => { await signOut(); renderNav(); });
  chip.append(av, name, menu);
  chip.addEventListener('click', () => menu.classList.toggle('open'));
  document.addEventListener('click', (e) => { if (chip && !chip.contains(e.target)) menu.classList.remove('open'); });
  navRight.insertBefore(chip, navRight.lastElementChild);
}

async function startDownload(platform = 'windows') {
  const status = document.querySelector('.dl-status');
  if (!isLoggedIn()) {
    try { sessionStorage.setItem('pg_dl_platform', platform); } catch {}
    openLogin({ subtitle: t('다운로드하려면 로그인하세요'), next: () => startDownload(platform) });
    return;
  }
  try {
    const r = await call('/api/download', { method: 'POST', body: JSON.stringify({ platform }) });
    if (!r.available) { toast(t('설치 파일이 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요.')); return; }
    if (status) status.textContent = t('다운로드를 시작합니다…');
    location.href = r.url;
  } catch (e) { toast(e.message); }
}

// The pending platform survives the Google redirect, so login → download picks the same file.
function pendingDownload() {
  let p = 'windows';
  try { p = sessionStorage.getItem('pg_dl_platform') || 'windows'; sessionStorage.removeItem('pg_dl_platform'); } catch {}
  return () => startDownload(p);
}

document.querySelectorAll('a[href="/download"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); startDownload(a.dataset.platform || 'windows'); }));
loginBtn.addEventListener('click', (e) => { e.preventDefault(); openLogin(); });

async function initAccount() {
  await loadAuthConfig();
  const m = location.hash.match(/^#auth=([\w-]{20,})/);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const user = await setToken(m[1], { sync: false });
      toast(t('로그인되었습니다'));
      let next = null;
      try { if (sessionStorage.getItem('pg_after_login') === 'download') next = pendingDownload(); sessionStorage.removeItem('pg_after_login'); } catch {}
      goAfterLogin(user, next);
      return;
    } catch (e) { toast(e.message); }
  } else if (auth.token) {
    await refreshUser();
  }
  renderNav();
  if (new URLSearchParams(location.search).get('login') === 'download') {
    history.replaceState(null, '', location.pathname + location.hash);
    pendingDownload()();
  }
}

initAccount();
