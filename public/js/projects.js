import { app, persist, emit } from './state.js';
import { h, icon, iconBtn, toast, uid, readFile, MAX_FILE, confirmDialog, modal, timeAgo, popover, menuItem, dataUrl, esc } from './ui.js';
import { createComposer, startChat, chatMenu } from './chat.js';
import { closeArtifact } from './artifacts.js';
import { t as tr } from './i18n.js';

function topbar(...children) {
  return h('header', { class: 'topbar' }, h('button', { class: 'icon-btn mobile-only', html: icon('menu'), onclick: () => document.body.classList.add('sidebar-open') }), ...children);
}

export function createProjectDialog() {
  const name = h('input', { type: 'text', placeholder: tr('예: 졸업 논문') });
  const desc = h('textarea', { rows: 3, placeholder: tr('이 프로젝트에서 무엇을 하려고 하나요?') });
  modal(tr('새 프로젝트'), h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('이름')), name), h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('설명 (선택)')), desc)), {
    actions: [{ label: tr('취소') }, {
      label: tr('프로젝트 만들기'), primary: true, onClick: () => {
        if (!name.value.trim()) { toast(tr('이름을 입력하세요')); return false; }
        const p = { id: uid(), name: name.value.trim(), description: desc.value.trim(), instructions: '', files: [], createdAt: Date.now(), updatedAt: Date.now() };
        app.projects.unshift(p);
        persist('projects'); emit('projects');
        location.hash = '#/project/' + p.id;
      },
    }],
  });
  setTimeout(() => name.focus(), 30);
}

export function renderProjects(container) {
  closeArtifact();
  const q = h('input', { type: 'search', placeholder: tr('프로젝트 검색'), class: 'search-input' });
  const grid = h('div', { class: 'project-grid' });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    grid.replaceChildren();
    const list = app.projects.filter((p) => !term || p.name.toLowerCase().includes(term) || (p.description || '').toLowerCase().includes(term));
    if (!list.length) grid.append(h('div', { class: 'empty' }, app.projects.length ? tr('검색 결과가 없습니다.') : tr('프로젝트로 관련 채팅, 지침, 자료를 한곳에 모아 보세요.')));
    list.forEach((p) => {
      const count = app.chats.filter((c) => c.projectId === p.id).length;
      grid.append(h('a', { class: 'project-card', href: '#/project/' + p.id },
        h('b', {}, p.name),
        h('p', { class: 'muted' }, p.description || tr('설명 없음')),
        h('small', { class: 'muted' }, tr('채팅 {c}개 · 자료 {f}개', { c: count, f: p.files?.length || 0 }) + ' · ' + timeAgo(p.updatedAt || p.createdAt))));
    });
  };
  q.addEventListener('input', draw);
  container.replaceChildren(h('div', { class: 'page' },
    topbar(h('h2', { class: 'page-title' }, tr('프로젝트')), h('div', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: createProjectDialog, html: icon('plus', 16) + '<span>' + esc(tr('새 프로젝트')) + '</span>' })),
    h('div', { class: 'page-inner' }, q, grid)));
  draw();
}

export function renderProject(container, id) {
  closeArtifact();
  const p = app.projects.find((x) => x.id === id);
  if (!p) { location.hash = '#/projects'; return; }
  const touch = () => { p.updatedAt = Date.now(); persist('projects'); emit('projects'); };

  const composer = createComposer({ onSubmit: (t, f) => startChat(t, f, p.id), placeholder: tr('{name} 프로젝트에서 새 채팅 시작', { name: p.name }) });

  const chatsEl = h('div', { class: 'project-chats' });
  const drawChats = () => {
    const chats = app.chats.filter((c) => c.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
    chatsEl.replaceChildren(...(chats.length ? chats.map((c) => h('div', { class: 'list-row' },
      h('a', { href: '#/chat/' + c.id }, h('b', {}, c.title), h('small', { class: 'muted' }, tr('마지막 메시지 {when}', { when: timeAgo(c.updatedAt) }))),
      iconBtn('more', tr('더보기'), (e) => chatMenu(e.currentTarget, c)))) : [h('div', { class: 'empty small' }, tr('아직 채팅이 없습니다. 위 입력창에서 시작하세요.'))]));
  };

  const instrPreview = h('p', { class: 'muted clamp' });
  const drawInstr = () => { instrPreview.textContent = p.instructions?.trim() || tr('AI가 이 프로젝트의 모든 채팅에서 따를 지침을 추가하세요.'); };
  const editInstr = () => {
    const ta = h('textarea', { rows: 12, placeholder: tr('예: 학술적인 문체로 답하고, 근거가 되는 자료의 출처를 함께 적어 주세요.') });
    ta.value = p.instructions || '';
    modal(tr('프로젝트 지침'), h('div', { class: 'form' }, h('p', { class: 'muted' }, tr('이 프로젝트의 모든 채팅에 적용됩니다.')), ta), {
      actions: [{ label: tr('취소') }, { label: tr('저장'), primary: true, onClick: () => { p.instructions = ta.value; touch(); drawInstr(); } }],
    });
  };

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const filesEl = h('div', { class: 'knowledge' });
  const drawFiles = () => {
    const total = (p.files || []).reduce((n, f) => n + (f.text?.length || 0), 0);
    filesEl.replaceChildren(
      ...(p.files || []).map((f, i) => h('div', { class: 'kfile' },
        f.data && f.mimeType.startsWith('image/') ? h('img', { src: dataUrl(f), alt: '' }) : h('span', { class: 'kf-icon', html: icon('file', 18) }),
        h('div', { class: 'kf-text' }, h('b', {}, f.name), h('small', { class: 'muted' }, f.text != null ? tr('{n}줄', { n: f.text.split('\n').length }) : f.mimeType)),
        iconBtn('x', tr('삭제'), () => { p.files.splice(i, 1); touch(); drawFiles(); }))),
      (p.files || []).length ? h('small', { class: 'muted' }, tr('텍스트 자료 약 {n}K자 · 모든 요청에 포함됩니다', { n: Math.round(total / 1000) })) : h('div', { class: 'empty small' }, tr('PDF, 문서, 코드, 이미지를 추가하면 AI가 참고합니다.')));
  };
  fileInput.addEventListener('change', async () => {
    for (const f of Array.from(fileInput.files)) {
      if (f.size > MAX_FILE) { toast(tr('{name}: 20MB 이하만 가능합니다', { name: f.name })); continue; }
      try { p.files.push(await readFile(f)); } catch { toast(tr('{name} 읽기 실패', { name: f.name })); }
    }
    fileInput.value = '';
    touch();
    drawFiles();
  });

  const nameEl = h('h1', { class: 'project-name', contenteditable: 'true', spellcheck: 'false' }, p.name);
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
  nameEl.addEventListener('blur', () => { const v = nameEl.textContent.trim(); if (v && v !== p.name) { p.name = v; touch(); } else nameEl.textContent = p.name; });
  const descEl = h('p', { class: 'muted project-desc', contenteditable: 'true', 'data-placeholder': tr('설명 추가') }, p.description || '');
  descEl.addEventListener('blur', () => { p.description = descEl.textContent.trim(); touch(); });

  const more = iconBtn('more', tr('더보기'), () => popover(more, h('div', { class: 'menu' },
    menuItem('trash', tr('프로젝트 삭제'), async () => {
      if (!(await confirmDialog(tr('"{name}" 프로젝트를 삭제할까요? 채팅은 남아 있고 프로젝트에서만 빠집니다.', { name: p.name }), { okLabel: tr('삭제'), danger: true }))) return;
      app.projects = app.projects.filter((x) => x.id !== p.id);
      app.chats.forEach((c) => { if (c.projectId === p.id) c.projectId = null; });
      persist('projects'); persist('chats'); emit('projects'); emit('chats');
      location.hash = '#/projects';
    }, { danger: true })), { align: 'right' }));

  container.replaceChildren(h('div', { class: 'page' },
    topbar(h('a', { class: 'crumb', href: '#/projects' }, h('span', { html: icon('left', 15) }), tr('모든 프로젝트')), h('div', { class: 'spacer' }), more),
    h('div', { class: 'project-layout' },
      h('div', { class: 'project-main' }, nameEl, descEl, composer.el, h('h3', { class: 'section-title' }, tr('채팅')), chatsEl),
      h('aside', { class: 'project-side' },
        h('section', { class: 'side-card' }, h('div', { class: 'side-head' }, h('b', {}, tr('지침')), iconBtn('edit', tr('지침 편집'), editInstr)), instrPreview),
        h('section', { class: 'side-card' }, h('div', { class: 'side-head' }, h('b', {}, tr('프로젝트 자료')), iconBtn('plus', tr('자료 추가'), () => fileInput.click())), filesEl, fileInput)))));
  drawChats(); drawInstr(); drawFiles();
}
