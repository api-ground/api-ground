import { app, initState, persist, on, emit } from './state.js';
import { $, h, icon, iconBtn, popover, menuItem, modal, toast } from './ui.js';
import { loadConfig, loadModels, anyKey } from './api.js';
import { renderHome, renderChat, leaveChat, chatMenu } from './chat.js';
import { renderProjects, renderProject, createProjectDialog } from './projects.js';
import { renderChats, renderArtifacts, renderApiTools, openSearch } from './pages.js';
import { renderCodeHome, renderCodeSession, leaveCode } from './code.js';
import { openSettings, applyTheme, setTheme, THEMES } from './settings.js';
import { t as tr, LANGUAGES, langSetting, setLanguage } from './i18n.js';
import { renderPanel, closeArtifact } from './artifacts.js';
import { auth, isLoggedIn, loadAuthConfig, needsLogin, renderLogin, setToken, signOut, initSync, initDesktopAuth, syncNow, refreshUser } from './account.js';

let current = { section: '', id: '' };

function parseHash() {
  const [, section = '', id = ''] = (location.hash || '#/').slice(1).split('?')[0].split('/');
  return { section, id: decodeURIComponent(id) };
}

async function route() {
  current = parseHash();
  const { section, id } = current;
  if (section === 'auth' && id) {
    history.replaceState(null, '', location.pathname + '#/');
    try {
      await setToken(id);
      toast(tr('로그인되었습니다'));
    } catch (e) { toast(e.message); }
    return route();
  }
  if (section !== 'login' && needsLogin()) { location.hash = '#/login'; return; }
  leaveChat();
  leaveCode();
  document.body.classList.remove('sidebar-open');
  document.body.classList.toggle('login-mode', section === 'login');
  const v = $('#view');
  if (section === 'login') { closeArtifact(); renderLogin(v); return; }
  if (section === 'chat' && id) renderChat(v, id);
  else if (section === 'chats') renderChats(v);
  else if (section === 'projects') renderProjects(v);
  else if (section === 'project' && id) renderProject(v, id);
  else if (section === 'artifacts') renderArtifacts(v);
  else if (section === 'code') id ? renderCodeSession(v, id) : renderCodeHome(v);
  else if (section === 'tools') renderApiTools(v);
  else renderHome(v);
  renderSidebar();
}

function navItem(ic, label, href, active, extra) {
  return h('a', { class: 'nav-item' + (active ? ' on' : ''), href, title: label }, h('span', { class: 'ni-icon', html: icon(ic) }), h('span', { class: 'ni-label' }, label), extra || null);
}

function chatRow(c) {
  const active = current.section === 'chat' && current.id === c.id;
  const more = iconBtn('more', tr('더보기'), (e) => { e.preventDefault(); e.stopPropagation(); chatMenu(e.currentTarget, c); }, 'row-more');
  return h('a', { class: 'recent' + (active ? ' on' : ''), href: '#/chat/' + c.id, title: c.title },
    h('span', { class: 'r-title' }, c.title), app.busy?.chatId === c.id ? h('span', { class: 'r-busy' }) : null, more);
}

export function openShortcuts() {
  const rows = [
    ['Ctrl + K', tr('채팅 검색')], ['Ctrl + Shift + O', tr('새 채팅')], ['Ctrl + /', tr('키보드 단축키 보기')],
    ['Enter', tr('보내기')], ['Shift + Enter', tr('줄바꿈')], ['Esc', tr('Code 모드 작업 중단 · 창 닫기')],
    ['Shift + Tab', tr('Code 모드 권한 모드 전환')], ['1 / 2 / 3', tr('Code 모드 승인 응답')],
  ];
  modal(tr('키보드 단축키'), h('div', { class: 'shortcut-list' }, rows.map(([k, d]) => h('div', { class: 'shortcut' }, h('span', {}, d), h('span', {}, k.split(' + ').map((x, i) => [i ? ' + ' : '', h('kbd', {}, x)]))))));
}

function renderSidebar() {
  const sb = $('#sidebar');
  const s = app.settings;
  const { section, id } = current;
  const starred = app.chats.filter((c) => c.starred).sort((a, b) => b.updatedAt - a.updatedAt);
  const recents = app.chats.filter((c) => !c.starred).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
  const codeRecents = [...app.code].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  const inCode = section === 'code';
  const u = isLoggedIn() ? auth.user : null;
  const displayName = s.name || u?.name || u?.email?.split('@')[0] || tr('사용자');

  const avatar = u?.avatar ? h('img', { class: 'avatar', src: u.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }, displayName.slice(0, 1).toUpperCase());
  const userBtn = h('button', { class: 'user-btn' },
    avatar,
    h('span', { class: 'ni-label' }, h('b', {}, displayName), h('small', {}, u ? u.email || tr('로그인됨') : anyKey() ? tr('API 연결됨') : tr('API 키 필요'))),
    h('span', { class: 'ni-label', html: icon('down', 14) }));
  userBtn.addEventListener('click', () => popover(userBtn, h('div', { class: 'menu' },
    u ? h('div', { class: 'menu-label' }, u.email || displayName) : null,
    menuItem('gear', tr('설정'), () => openSettings()),
    menuItem('pin', tr('API 키'), () => openSettings('keys')),
    menuItem('bulb', tr('메모리'), () => openSettings('memory')),
    menuItem('list', tr('키보드 단축키'), openShortcuts, { right: 'Ctrl /' }),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-label' }, tr('화면 테마')),
    ...THEMES.map(([v, l]) => menuItem(v === 'dark' ? 'moon' : v === 'light' ? 'sun' : 'monitor', l, () => setTheme(v), { right: s.theme === v ? h('span', { html: icon('check', 16) }) : '' })),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-label' }, tr('언어')),
    ...LANGUAGES.map((l) => menuItem(l.id === 'system' ? 'globe' : null, l.label || tr('시스템 언어 따르기'), () => { if (langSetting() !== l.id) setLanguage(l.id); }, { right: langSetting() === l.id ? h('span', { html: icon('check', 16) }) : '' })),
    h('div', { class: 'menu-sep' }),
    u ? menuItem('x', tr('로그아웃'), async () => { await signOut(); renderSidebar(); })
      : menuItem('right', tr('로그인'), () => { location.hash = '#/login'; }),
  ), { place: 'above', width: 250 }));

  sb.replaceChildren(
    h('div', { class: 'sb-top' },
      h('a', { class: 'brand', href: '#/' }, h('img', { class: 'brand-logo', src: 'img/logo.png', alt: '' }), h('span', { class: 'ni-label' }, 'API-Ground')),
      iconBtn('sidebar', s.sidebarCollapsed ? tr('사이드바 펼치기') : tr('사이드바 접기'), () => { s.sidebarCollapsed = !s.sidebarCollapsed; persist('settings'); applyCollapse(); renderSidebar(); }, 'collapse-btn')),
    h('a', { class: 'new-chat', href: '#/', title: tr('새 채팅 (Ctrl+Shift+O)'), onclick: () => { if (location.hash === '#/' || !location.hash) route(); } }, h('span', { class: 'nc-icon', html: icon('plus', 16) }), h('span', { class: 'ni-label' }, tr('새 채팅'))),
    h('nav', { class: 'sb-nav' },
      h('button', { class: 'nav-item', onclick: openSearch, title: tr('검색 (Ctrl+K)') }, h('span', { class: 'ni-icon', html: icon('search') }), h('span', { class: 'ni-label' }, tr('검색')), h('kbd', { class: 'ni-label' }, 'Ctrl K')),
      navItem('chat', tr('채팅'), '#/chats', section === 'chats'),
      navItem('folder', tr('프로젝트'), '#/projects', section === 'projects' || section === 'project'),
      navItem('layers', tr('아티팩트'), '#/artifacts', section === 'artifacts'),
      navItem('terminal', 'Code', '#/code', inCode),
      navItem('sliders', tr('API 도구'), '#/tools', section === 'tools')),
    h('div', { class: 'sb-scroll' },
      inCode ? h('div', { class: 'sb-section' }, h('div', { class: 'sb-label' }, h('span', {}, tr('Code 세션')), iconBtn('plus', tr('새 세션'), () => { location.hash = '#/code'; }, 'tiny')),
        codeRecents.map((cs) => h('a', { class: 'recent' + (id === cs.id ? ' on' : ''), href: '#/code/' + cs.id, title: cs.title }, h('span', { class: 'r-title' }, cs.title))),
        codeRecents.length ? null : h('div', { class: 'sb-empty' }, tr('세션이 없습니다'))) : null,
      !inCode && starred.length ? h('div', { class: 'sb-section' }, h('div', { class: 'sb-label' }, tr('즐겨찾기')), starred.map(chatRow)) : null,
      !inCode && app.projects.length ? h('div', { class: 'sb-section' }, h('div', { class: 'sb-label' }, h('span', {}, tr('프로젝트')), iconBtn('plus', tr('새 프로젝트'), createProjectDialog, 'tiny')),
        app.projects.slice(0, 8).map((p) => h('a', { class: 'recent' + (section === 'project' && id === p.id ? ' on' : ''), href: '#/project/' + p.id }, h('span', { class: 'r-icon', html: icon('folder', 14) }), h('span', { class: 'r-title' }, p.name)))) : null,
      !inCode ? h('div', { class: 'sb-section' }, h('div', { class: 'sb-label' }, tr('최근 항목')), recents.map(chatRow), recents.length ? null : h('div', { class: 'sb-empty' }, tr('채팅 기록이 여기에 표시됩니다'))) : null),
    h('div', { class: 'sb-foot' }, userBtn),
  );
}

function applyCollapse() {
  document.body.classList.toggle('sb-collapsed', Boolean(app.settings.sidebarCollapsed));
}

on((evt) => {
  if (['chats', 'projects', 'code', 'settings', 'busy', 'auth'].includes(evt) && current.section !== 'login') renderSidebar();
  if (evt === 'chats' && current.section === 'chats') route();
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); location.hash = '#/'; route(); }
  else if (mod && e.key === '/') { e.preventDefault(); openShortcuts(); }
});

window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (document.body.classList.contains('artifact-open')) renderPanel(); });

async function init() {
  await initState();
  applyTheme();
  applyCollapse();
  $('#scrim').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  initSync();
  initDesktopAuth();
  await Promise.all([loadConfig(), loadAuthConfig()]);
  await loadModels(app.settings.provider);
  await route();
  loadModels(app.settings.provider).then(() => emit('settings'));
  if (isLoggedIn()) { refreshUser(); syncNow(false).catch(() => {}); }
}

init();
