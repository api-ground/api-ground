import { app } from './state.js';
import { h, icon, iconBtn, toast, timeAgo, modal, copyText, esc } from './ui.js';
import { postJSON, hasKey, loadModels, currentModel } from './api.js';
import { pathOf, assistantText, chatMenu } from './chat.js';
import { splitArtifacts, kindLabel, openArtifact, closeArtifact } from './artifacts.js';
import { openSettings } from './settings.js';
import { t as tr } from './i18n.js';

function topbar(...children) {
  return h('header', { class: 'topbar' }, h('button', { class: 'icon-btn mobile-only', html: icon('menu'), onclick: () => document.body.classList.add('sidebar-open') }), ...children);
}

function chatSearchText(c) {
  return Object.values(c.nodes).map((n) => (n.role === 'user' ? n.text || '' : assistantText(n))).join('\n');
}

function snippet(text, term) {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return '';
  const s = Math.max(0, i - 40);
  return (s ? '…' : '') + text.slice(s, i + term.length + 60).replace(/\s+/g, ' ') + '…';
}

// ---------- all chats ----------
export function renderChats(container) {
  closeArtifact();
  const q = h('input', { type: 'search', placeholder: tr('채팅 검색...'), class: 'search-input' });
  const list = h('div', { class: 'chat-rows' });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = app.chats
      .map((c) => ({ c, snip: term && !c.title.toLowerCase().includes(term) ? snippet(chatSearchText(c), term) : '' }))
      .filter(({ c, snip }) => !term || c.title.toLowerCase().includes(term) || snip)
      .sort((a, b) => b.c.updatedAt - a.c.updatedAt);
    list.replaceChildren(...(rows.length ? rows.map(({ c, snip }) => {
      const project = c.projectId && app.projects.find((p) => p.id === c.projectId);
      return h('div', { class: 'list-row' },
        h('a', { href: '#/chat/' + c.id },
          h('b', {}, c.starred ? h('span', { class: 'star-mark', html: icon('star', 13) }) : null, c.title),
          snip ? h('small', { class: 'snip' }, snip) : null,
          h('small', { class: 'muted' }, (project ? project.name + ' · ' : '') + tr('마지막 메시지 {when}', { when: timeAgo(c.updatedAt) }))),
        iconBtn('more', tr('더보기'), (e) => chatMenu(e.currentTarget, c)));
    }) : [h('div', { class: 'empty' }, app.chats.length ? tr('검색 결과가 없습니다.') : tr('아직 채팅이 없습니다.'))]));
  };
  q.addEventListener('input', draw);
  container.replaceChildren(h('div', { class: 'page' },
    topbar(h('h2', { class: 'page-title' }, tr('채팅')), h('div', { class: 'spacer' }), h('a', { class: 'btn primary', href: '#/', html: icon('plus', 16) + '<span>' + esc(tr('새 채팅')) + '</span>' })),
    h('div', { class: 'page-inner' }, q, h('p', { class: 'muted small' }, tr('채팅 {n}개', { n: app.chats.length })), list)));
  draw();
  q.focus();
}

// ---------- search modal (Ctrl+K) ----------
export function openSearch() {
  const q = h('input', { type: 'search', placeholder: tr('채팅 검색...'), class: 'search-input big' });
  const list = h('div', { class: 'search-results' });
  let m;
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = app.chats
      .map((c) => ({ c, snip: term ? snippet(chatSearchText(c), term) : '' }))
      .filter(({ c, snip }) => !term || c.title.toLowerCase().includes(term) || snip)
      .sort((a, b) => b.c.updatedAt - a.c.updatedAt)
      .slice(0, 30);
    list.replaceChildren(...(rows.length ? rows.map(({ c, snip }) => h('a', {
      class: 'search-row', href: '#/chat/' + c.id, onclick: () => m.close(),
    }, h('span', { html: icon('chat', 16) }), h('span', { class: 'sr-text' }, h('b', {}, c.title), snip ? h('small', {}, snip) : h('small', { class: 'muted' }, timeAgo(c.updatedAt))))) : [h('div', { class: 'empty small' }, tr('결과 없음'))]));
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = list.querySelector('a'); if (first) { first.click(); location.hash = first.getAttribute('href'); } }
  });
  m = modal(tr('채팅 검색'), h('div', {}, q, list));
  draw();
  setTimeout(() => q.focus(), 30);
}

// ---------- artifacts gallery ----------
export function renderArtifacts(container) {
  closeArtifact();
  const items = [];
  for (const c of app.chats) {
    const latest = new Map();
    pathOf(c).filter((n) => n.role === 'assistant').forEach((n) => {
      splitArtifacts(assistantText(n)).filter((s) => s.type === 'artifact' && s.complete).forEach((s) => latest.set(s.id, { ...s, chat: c, at: n.createdAt }));
    });
    items.push(...latest.values());
  }
  items.sort((a, b) => b.at - a.at);
  const grid = h('div', { class: 'artifact-grid' }, items.length ? items.map((a) => h('button', {
    class: 'artifact-tile',
    onclick: () => { location.hash = '#/chat/' + a.chat.id; setTimeout(() => openArtifact(a.chat.id, a.id), 80); },
  },
  h('div', { class: 'at-preview' }, h('pre', {}, a.content.slice(0, 600))),
  h('div', { class: 'at-meta' }, h('b', {}, a.title), h('small', { class: 'muted' }, kindLabel(a.kind) + ' · ' + a.chat.title + ' · ' + timeAgo(a.at))))) : h('div', { class: 'empty' }, tr('아직 아티팩트가 없습니다. 채팅에서 "웹페이지 만들어줘", "다이어그램 그려줘"처럼 요청해 보세요.')));
  container.replaceChildren(h('div', { class: 'page' },
    topbar(h('h2', { class: 'page-title' }, tr('아티팩트'))),
    h('div', { class: 'page-inner wide' }, grid)));
}

// ---------- API tools: embeddings & tokens ----------
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function renderApiTools(container) {
  closeArtifact();
  const embedModel = h('select');
  const task = h('select', {}, ['', 'SEMANTIC_SIMILARITY', 'RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT', 'CLASSIFICATION', 'CLUSTERING'].map((v) => h('option', { value: v }, v || tr('기본'))));
  const dims = h('input', { type: 'number', min: 1, placeholder: tr('예: 768') });
  const input = h('textarea', { rows: 6, placeholder: tr('고양이는 귀엽다\n강아지는 사랑스럽다\n주식 시장이 하락했다') });
  const out = h('div');
  let last = null;
  const copyBtn = h('button', { class: 'btn ghost', hidden: true, onclick: () => last && copyText(JSON.stringify(last), tr('JSON을 복사했습니다')) }, tr('JSON 복사'));
  const runBtn = h('button', { class: 'btn primary' }, tr('임베딩 생성'));
  runBtn.addEventListener('click', async () => {
    const texts = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!texts.length) return toast(tr('텍스트를 입력하세요'));
    if (!hasKey('gemini')) return openSettings('keys');
    runBtn.disabled = true;
    out.replaceChildren(h('p', { class: 'muted' }, tr('계산 중...')));
    try {
      const d = parseInt(dims.value, 10);
      const data = await postJSON('/api/embed', 'gemini', { model: embedModel.value, texts, taskType: task.value || undefined, dimensions: d > 0 ? d : undefined });
      last = texts.map((t, i) => ({ text: t, embedding: data.embeddings[i] }));
      let html = '<p class="stat">' + esc(tr('{n}개 · {d}차원', { n: texts.length, d: data.embeddings[0]?.length || 0 })) + '</p>';
      texts.forEach((t, i) => {
        const v = data.embeddings[i] || [];
        html += '<div class="vec"><b>' + esc(t) + '</b><br>[' + v.slice(0, 8).map((x) => x.toFixed(5)).join(', ') + (v.length > 8 ? ', …' : '') + ']</div>';
      });
      if (texts.length > 1) {
        html += '<h4>' + esc(tr('코사인 유사도')) + '</h4><div class="table-wrap"><table class="sim"><tr><th></th>' + texts.map((t) => '<th title="' + esc(t) + '">' + esc(t) + '</th>').join('') + '</tr>';
        texts.forEach((t, i) => {
          html += '<tr><th title="' + esc(t) + '">' + esc(t) + '</th>' + texts.map((_, j) => {
            const s = cosine(data.embeddings[i], data.embeddings[j]);
            return '<td style="background:color-mix(in srgb, var(--accent) ' + Math.round(Math.max(0, s) * 55) + '%, transparent)">' + s.toFixed(3) + '</td>';
          }).join('') + '</tr>';
        });
        html += '</table></div>';
      }
      out.innerHTML = html;
      copyBtn.hidden = false;
    } catch (e) {
      out.replaceChildren(h('div', { class: 'msg-error' }, e.message));
    } finally { runBtn.disabled = false; }
  });

  const tokInput = h('textarea', { rows: 8, placeholder: tr('토큰 수를 계산할 텍스트') });
  const tokOut = h('span', { class: 'stat' });
  const tokBtn = h('button', { class: 'btn primary' }, tr('토큰 계산'));
  tokBtn.addEventListener('click', async () => {
    if (!tokInput.value.trim()) return;
    if (!hasKey('gemini')) return openSettings('keys');
    tokOut.textContent = tr('계산 중...');
    try {
      const model = currentModel('gemini');
      const d = await postJSON('/api/tokens', 'gemini', { model, messages: [{ role: 'user', text: tokInput.value }] });
      tokOut.textContent = tr('{n} 토큰 · {c}자', { n: d.totalTokens.toLocaleString(), c: tokInput.value.length.toLocaleString() }) + ' (' + model + ')';
    } catch (e) { tokOut.textContent = tr('오류: ') + e.message; }
  });

  container.replaceChildren(h('div', { class: 'page' },
    topbar(h('h2', { class: 'page-title' }, tr('API 도구'))),
    h('div', { class: 'page-inner' },
      h('section', { class: 'card' }, h('h3', {}, tr('텍스트 임베딩')), h('p', { class: 'muted' }, tr('한 줄에 하나씩 입력하면 벡터와 문장 간 유사도를 계산합니다. (Gemini)')),
        h('div', { class: 'grid3' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('모델')), embedModel), h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('작업 유형')), task), h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('출력 차원')), dims)),
        input, h('div', { class: 'row' }, runBtn, copyBtn), out),
      h('section', { class: 'card' }, h('h3', {}, tr('토큰 계산')), h('p', { class: 'muted' }, tr('선택된 Gemini 모델 기준으로 계산합니다.')), tokInput, h('div', { class: 'row' }, tokBtn, tokOut)))));

  const models = await loadModels('gemini');
  const embeds = models.embed?.length ? models.embed : [{ id: 'gemini-embedding-001' }];
  embedModel.replaceChildren(...embeds.map((m) => h('option', { value: m.id }, m.id)));
}
