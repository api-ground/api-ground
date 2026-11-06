import { app, persist, emit, on } from './state.js';
import { h, icon, iconBtn, toast, popover, closePopover, menuItem, toggleSwitch, uid, readFile, dataUrl, copyText, MAX_FILE, promptDialog, confirmDialog, modal, downloadBlob } from './ui.js';
import { streamChat, complete, currentModel, modelLabel, providerInfo, isGemini, hasKey, loadModels, brandImg, brandHTML, modelBrand } from './api.js';
import { renderMarkdown } from './markdown.js';
import { ARTIFACT_PROMPT, splitArtifacts, collectVersions, artifactCard, openArtifact, renderPanel, setVersionProvider, isPanelOpenFor, closeArtifact } from './artifacts.js';
import { openSettings } from './settings.js';
import { shareChat } from './account.js';
import { t as tr, locale } from './i18n.js';
import { recordUsage, recordLimits, recordLimitError, fallbackCandidates, switchTo, switchActions, usageButton } from './usage.js';

// ---------- styles ----------
export const BUILTIN_STYLES = [
  { id: 'normal', name: tr('기본'), desc: tr('기본 응답 스타일'), prompt: '' },
  { id: 'concise', name: tr('간결하게'), desc: tr('짧고 핵심만'), prompt: 'Be concise. Give the essential answer directly, skip preambles, caveats and repetition. Prefer short paragraphs and bullet points.' },
  { id: 'explanatory', name: tr('자세히 설명'), desc: tr('교육적이고 친절하게'), prompt: 'Explain like a patient teacher: give background, step-by-step reasoning, concrete examples and analogies, and check understanding. Thoroughness is preferred over brevity.' },
  { id: 'formal', name: tr('격식체'), desc: tr('명확하고 전문적으로'), prompt: 'Write in a formal, professional and well-structured register. Use precise language, clear headings where helpful, and avoid casual expressions.' },
];
export const allStyles = () => [...BUILTIN_STYLES, ...app.settings.customStyles];

// ---------- tree helpers ----------
export function newChat(projectId = null) {
  const chat = { id: uid(), title: tr('새 채팅'), projectId, starred: false, createdAt: Date.now(), updatedAt: Date.now(), nodes: {}, roots: [], sel: {} };
  app.chats.unshift(chat);
  return chat;
}

const kidsOf = (chat, key) => (key === 'root' ? chat.roots : chat.nodes[key]?.children || []);

export function pathOf(chat) {
  const out = [];
  let key = 'root';
  for (;;) {
    const kids = kidsOf(chat, key);
    if (!kids.length) break;
    const id = kids.includes(chat.sel[key]) ? chat.sel[key] : kids[kids.length - 1];
    const node = chat.nodes[id];
    if (!node) break;
    out.push(node);
    key = node.id;
  }
  return out;
}

function addNode(chat, parentId, data) {
  const node = { id: uid(), parent: parentId, children: [], createdAt: Date.now(), ...data };
  chat.nodes[node.id] = node;
  const key = parentId ?? 'root';
  kidsOf(chat, key).push(node.id);
  chat.sel[key] = node.id;
  return node;
}

export const assistantText = (n) => (n.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');

const MEMORY_RE = /\s*<memory>([\s\S]*?)(<\/memory>|$)/g;
const stripMemory = (text) => text.replace(MEMORY_RE, '');

// Moves <memory>…</memory> lines out of the reply and into settings.memories.
function saveMemories(chat, node) {
  const found = [];
  for (const p of node.parts || []) {
    if (p.type !== 'text' || !p.text.includes('<memory>')) continue;
    p.text = p.text.replace(MEMORY_RE, (m, fact, close) => { if (close && fact.trim()) found.push(fact.trim().slice(0, 300)); return ''; });
  }
  if (!found.length) return;
  const s = app.settings;
  const known = new Set(s.memories.map((m) => m.text));
  const fresh = found.filter((f) => !known.has(f));
  if (s.memoryEnabled && fresh.length) {
    s.memories = [...fresh.map((text) => ({ id: uid(), text, createdAt: Date.now() })), ...s.memories].slice(0, 200);
    persist('settings');
  }
  node.memories = fresh;
  persist('chats');
  renderChatIfVisible(chat);
}

function docBlock(f) { return '<document name="' + f.name.replace(/"/g, '') + '">\n' + f.text + '\n</document>'; }

function userText(n) {
  const docs = (n.files || []).filter((f) => f.text != null);
  return (docs.length ? docs.map(docBlock).join('\n') + '\n\n' : '') + (n.text || '');
}

const projectOf = (chat) => (chat.projectId ? app.projects.find((p) => p.id === chat.projectId) : null);

function buildSystem(chat) {
  const s = app.settings;
  const parts = [];
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  parts.push('You are a helpful, honest and thoughtful AI assistant. Today is ' + today + '. Reply in the language the user writes in. Use Markdown when it improves readability; write math in LaTeX using $...$ or $$...$$.');
  if (s.name) parts.push("The user's name is " + s.name + '.');
  if (s.preferences.trim()) parts.push('# About the user and their preferences\n' + s.preferences.trim());
  const project = projectOf(chat);
  if (project) {
    parts.push('# Project: ' + project.name + (project.description ? '\n' + project.description : ''));
    if (project.instructions?.trim()) parts.push('# Project instructions\n' + project.instructions.trim());
    const docs = (project.files || []).filter((f) => f.text != null);
    if (docs.length) parts.push('# Project knowledge\n' + docs.map(docBlock).join('\n'));
  }
  const style = allStyles().find((x) => x.id === s.style);
  if (style?.prompt) parts.push('# Response style: ' + style.name + '\n' + style.prompt);
  if (s.memoryEnabled) {
    const mem = s.memories.slice(0, 100).map((m) => '- ' + m.text).join('\n');
    parts.push('# Memory\n' + (mem ? 'Things you remember about the user from earlier conversations:\n' + mem + '\n\n' : '')
      + 'When the user explicitly asks you to remember something, or shares a lasting preference or fact about themselves, add one line at the very end of your reply in the form <memory>short fact in the user\'s language</memory>. Use it sparingly, never for temporary details, and do not mention the tag.');
  }
  if (s.artifacts) parts.push(ARTIFACT_PROMPT);
  if (s.systemPrompt.trim()) parts.push('# Additional instructions\n' + s.systemPrompt.trim());
  return parts.join('\n\n');
}

function apiHistory(chat, path, gem) {
  const project = projectOf(chat);
  const projectFiles = (project?.files || []).filter((f) => f.data);
  const usable = path.filter((n) => n.role === 'user' || assistantText(n) || (n.parts || []).some((p) => p.type === 'image' && p.data));
  return usable.map((n, i) => {
    if (n.role === 'user') {
      let files = (n.files || []).filter((f) => f.data);
      if (i === 0) files = [...projectFiles, ...files];
      return { role: 'user', text: userText(n), files: files.map((f) => ({ mimeType: f.mimeType, data: f.data })) };
    }
    const images = gem ? (n.parts || []).filter((p) => p.type === 'image' && p.data).map((p) => ({ mimeType: p.mimeType, data: p.data })) : [];
    return { role: 'assistant', text: assistantText(n), files: images };
  });
}

// ---------- view state ----------
let view = null; // { chatId, list, els: Map(nodeId -> el), header }

function versionsFor(chatId) {
  const chat = app.chats.find((c) => c.id === chatId);
  if (!chat) return new Map();
  return collectVersions(pathOf(chat).filter((n) => n.role === 'assistant').map((n) => ({ id: n.id, text: assistantText(n), streaming: n.streaming })));
}
setVersionProvider(versionsFor);

// ---------- generation ----------
export async function sendMessage(chat, text, files) {
  const parent = pathOf(chat).at(-1)?.id ?? null;
  const node = addNode(chat, parent, { role: 'user', text, files });
  chat.updatedAt = Date.now();
  persist('chats');
  await generate(chat, node.id);
}

// auto: how many automatic switches already happened for this reply (stops after a few providers).
// from: the provider that hit its limit, when this reply continues its work.
async function generate(chat, parentId, auto = 0, from = null) {
  if (app.busy) return;
  const provider = app.settings.provider;
  const model = currentModel(provider);
  if (!hasKey(provider)) { openSettings('keys'); toast(tr('{name} API 키를 먼저 입력하세요', { name: providerInfo(provider).name })); return; }

  const node = addNode(chat, parentId, { role: 'assistant', parts: [], provider, model, streaming: true, ...(from ? { handoffFrom: from } : {}) });
  const history = apiHistory(chat, pathOf(chat).slice(0, -1), isGemini(provider));
  const ctrl = new AbortController();
  app.busy = { ctrl, chatId: chat.id, nodeId: node.id };
  emit('busy');
  renderChatIfVisible(chat);

  let thinkStart = null;
  let autoOpened = false;
  const addText = (type, text) => {
    const last = node.parts[node.parts.length - 1];
    if (last && last.type === type) last.text += text; else node.parts.push({ type, text });
  };

  let pending = false;
  const refresh = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!autoOpened && app.settings.artifacts) {
        const seg = splitArtifacts(assistantText(node)).find((s) => s.type === 'artifact');
        if (seg && view?.chatId === chat.id) { autoOpened = true; openArtifact(chat.id, seg.id); }
      }
      updateNodeEl(chat, node);
      if (isPanelOpenFor(chat.id)) renderPanel();
    });
  };

  try {
    const stream = streamChat({
      provider, model, messages: history, systemPrompt: buildSystem(chat),
      params: { ...app.settings.params }, tools: isGemini(provider) ? app.settings.tools : {},
    }, ctrl.signal);
    for await (const ev of stream) {
      switch (ev.type) {
        case 'thought':
          if (thinkStart == null) thinkStart = performance.now();
          addText('thought', ev.text);
          break;
        case 'text':
          if (thinkStart != null && node.thinkMs == null) node.thinkMs = performance.now() - thinkStart;
          addText('text', ev.text);
          break;
        case 'image': node.parts.push({ type: 'image', mimeType: ev.mimeType, data: ev.data }); break;
        case 'code': node.parts.push({ type: 'code', language: ev.language, code: ev.code }); break;
        case 'codeResult': node.parts.push({ type: 'codeResult', outcome: ev.outcome, output: ev.output }); break;
        case 'sources': {
          const m = new Map((node.sources || []).map((s) => [s.uri, s]));
          ev.sources.forEach((s) => m.set(s.uri, s));
          node.sources = [...m.values()];
          break;
        }
        case 'usage': node.usage = { input: ev.input, output: ev.output }; break;
        case 'limits': recordLimits(provider, ev); break;
        case 'finish':
          node.error = ev.reason === 'MAX_TOKENS' || ev.reason === 'length' ? tr('최대 출력 길이에 도달해 응답이 잘렸습니다.') : tr('응답이 중단되었습니다: ') + ev.reason;
          break;
        case 'error':
          node.error = ev.message;
          if (ev.limit) { node.limit = ev.limit; recordLimitError(provider, ev); }
          break;
      }
      refresh();
    }
    if (thinkStart != null && node.thinkMs == null) node.thinkMs = performance.now() - thinkStart;
    if (!node.parts.length && !node.error) node.error = tr('빈 응답을 받았습니다.');
  } catch (e) {
    if (e.name === 'AbortError') { if (!node.parts.length) node.error = tr('사용자가 중지했습니다.'); }
    else {
      node.error = e.message;
      if (e.limit) { node.limit = e.limit; recordLimitError(provider, e); }
    }
  } finally {
    delete node.streaming;
    app.busy = null;
    chat.updatedAt = Date.now();
    persist('chats');
    emit('busy');
    emit('chats');
    renderChatIfVisible(chat);
    if (isPanelOpenFor(chat.id)) renderPanel();
    saveMemories(chat, node);
    if (!node.error || node.parts.length) recordUsage(provider, node.usage);
    if (!node.limit) maybeTitle(chat, provider, model);
  }
  // The provider hit its limit: hand the same conversation to another AI so the work continues.
  if (node.limit && app.settings.autoSwitch && auto < 3) {
    const next = fallbackCandidates(provider)[0];
    if (next) {
      node.switchedTo = next.provider;
      persist('chats');
      switchTo(next.provider);
      toast(tr('{from} 한도에 걸려 {to} 모델로 이어서 답합니다', { from: providerInfo(provider).name, to: modelLabel(next.model) }));
      await generate(chat, parentId, auto + 1, provider);
    }
  }
}

async function maybeTitle(chat, provider, model) {
  if (!app.settings.autoTitle || chat.titled) return;
  const path = pathOf(chat);
  const u = path.find((n) => n.role === 'user');
  const a = path.find((n) => n.role === 'assistant' && assistantText(n));
  if (!u || !a) return;
  chat.titled = true;
  try {
    const t = await complete({
      provider, model, tools: {}, params: {},
      messages: [{ role: 'user', text: 'Write a short title (at most 6 words) for a conversation that begins with the message below. Use the same language as the message. Reply with the title only, without quotes or punctuation at the end.\n\n---\n' + userText(u).slice(0, 3000) }],
    });
    const clean = t.replace(/["'`*#]/g, '').split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 60);
    if (clean) { chat.title = clean; persist('chats'); emit('chats'); if (view?.chatId === chat.id) renderHeader(chat); }
  } catch {
    if (chat.title === tr('새 채팅')) { chat.title = (u.text || tr('새 채팅')).slice(0, 40); persist('chats'); emit('chats'); }
  }
}

export function stopGeneration() { app.busy?.ctrl.abort(); }

// ---------- composer ----------
const composers = new Set();
on((evt) => { if (evt === 'busy' || evt === 'settings') composers.forEach((c) => (c.el.isConnected ? c.refresh() : composers.delete(c))); });

// Electron has no speech recognition backend, so dictation is web-only.
const SpeechRec = window.desktop ? null : window.SpeechRecognition || window.webkitSpeechRecognition;

export function createComposer({ onSubmit, placeholder = tr('무엇이든 물어보세요'), big = false }) {
  const files = [];
  const ta = h('textarea', { rows: 1, placeholder });
  const attachRow = h('div', { class: 'attach-row' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });

  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, big ? 320 : 260) + 'px'; refresh(); };

  async function addFiles(list) {
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE) { toast(tr('{name}: 20MB 이하만 첨부할 수 있습니다', { name: f.name })); continue; }
      try { files.push(await readFile(f)); } catch { toast(tr('{name} 파일을 읽지 못했습니다', { name: f.name })); }
    }
    renderAttach();
  }

  function renderAttach() {
    attachRow.innerHTML = '';
    files.forEach((f, i) => {
      const rm = iconBtn('x', tr('제거'), () => { files.splice(i, 1); renderAttach(); }, 'att-x');
      if (f.data && f.mimeType.startsWith('image/')) {
        attachRow.append(h('div', { class: 'att img' }, h('img', { src: dataUrl(f), alt: f.name }), rm));
      } else {
        const sub = f.text != null ? tr('{n}줄', { n: f.text.split('\n').length }) : (f.mimeType.split('/')[1] || 'file').toUpperCase();
        attachRow.append(h('div', { class: 'att' }, h('span', { class: 'att-icon', html: icon('file', 16) }), h('span', { class: 'att-name' }, h('b', {}, f.name), h('small', {}, sub)), rm));
      }
    });
    refresh();
  }

  function submit() {
    if (app.busy) { stopGeneration(); return; }
    const text = ta.value.trim();
    if (!text && !files.length) return;
    const sent = files.splice(0);
    ta.value = '';
    grow();
    renderAttach();
    onSubmit(text, sent);
  }

  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  ta.addEventListener('paste', (e) => {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (pasted.length) { e.preventDefault(); addFiles(pasted); return; }
    const text = e.clipboardData?.getData('text') || '';
    if (text.length > 4000) {
      e.preventDefault();
      files.push({ name: tr('붙여넣은 텍스트 {n}', { n: files.length + 1 }) + '.txt', mimeType: 'text/plain', text, size: text.length });
      renderAttach();
    }
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  const plusBtn = h('button', { class: 'cbtn', title: tr('파일 첨부 · 스타일'), html: icon('plus') });
  plusBtn.addEventListener('click', () => {
    const styleList = h('div', {}, allStyles().map((s) => menuItem(null, s.name, () => { app.settings.style = s.id; persist('settings'); emit('settings'); }, { desc: s.desc, right: app.settings.style === s.id ? h('span', { html: icon('check', 16) }) : '' })));
    popover(plusBtn, h('div', { class: 'menu' },
      menuItem('clip', tr('파일 또는 사진 추가'), () => fileInput.click()),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-label' }, tr('스타일 사용')),
      styleList,
      menuItem('plus', tr('스타일 만들기'), () => createStyleDialog()),
    ), { width: 260 });
  });

  const toolsBtn = h('button', { class: 'cbtn', title: tr('검색 및 도구'), html: icon('sliders') });
  toolsBtn.addEventListener('click', () => {
    const t = app.settings.tools;
    const gem = isGemini();
    const row = (ic, label, key, desc, enabled = true) => menuItem(ic, label, () => {}, {
      keepOpen: true, desc: enabled ? desc : tr('Gemini 모델에서만 사용 가능'),
      right: toggleSwitch(enabled && Boolean(key === 'artifacts' ? app.settings.artifacts : t[key]), (v) => {
        if (key === 'artifacts') app.settings.artifacts = v; else t[key] = v;
        persist('settings'); emit('settings');
      }),
    });
    popover(toolsBtn, h('div', { class: 'menu' },
      row('globe', tr('웹 검색'), 'search', tr('Google 검색으로 최신 정보 반영'), gem),
      row('bulb', tr('확장 사고'), 'thinking', tr('답하기 전에 생각 과정을 보여줌')),
      row('layers', tr('아티팩트'), 'artifacts', tr('코드·문서·앱을 별도 패널에 생성')),
      row('eye', tr('URL 읽기'), 'urlContext', tr('메시지 속 링크의 내용을 읽음'), gem),
      row('terminal', tr('코드 실행'), 'codeExecution', tr('파이썬 코드를 실행해 계산'), gem),
    ), { width: 300 });
  });

  const styleChip = h('button', { class: 'style-chip', title: tr('스타일 해제'), onclick: () => { app.settings.style = 'normal'; persist('settings'); emit('settings'); } });
  const toolChips = h('div', { class: 'tool-chips' });

  const modelBtn = h('button', { class: 'model-btn' });
  modelBtn.addEventListener('click', () => openModelPicker(modelBtn));

  let rec = null;
  const micBtn = SpeechRec ? h('button', { class: 'cbtn', title: tr('음성 입력'), html: icon('mic') }) : null;
  micBtn?.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SpeechRec();
    rec.lang = locale();
    rec.interimResults = true;
    rec.continuous = true;
    const base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    rec.onresult = (e) => {
      let s = '';
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
      ta.value = base + s;
      grow();
    };
    rec.onend = () => { rec = null; micBtn.classList.remove('rec'); };
    rec.onerror = (e) => toast(tr('음성 인식 오류: ') + e.error);
    rec.start();
    micBtn.classList.add('rec');
  });

  const sendBtn = h('button', { class: 'send-btn', onclick: submit });

  function refresh() {
    const style = allStyles().find((s) => s.id === app.settings.style);
    styleChip.hidden = !style || style.id === 'normal';
    styleChip.innerHTML = icon('pen', 14) + '<span>' + escapeHTML(style?.name || '') + '</span>' + icon('x', 12);
    const t = app.settings.tools;
    const gem = isGemini();
    toolChips.innerHTML = '';
    if (gem && t.search) toolChips.append(h('span', { class: 'tchip', html: icon('globe', 14) + '<span>' + escapeHTML(tr('검색')) + '</span>' }));
    if (t.thinking) toolChips.append(h('span', { class: 'tchip', html: icon('bulb', 14) + '<span>' + escapeHTML(tr('확장 사고')) + '</span>' }));
    const m = currentModel();
    modelBtn.innerHTML = brandHTML(modelBrand(m, app.settings.provider), 16) + '<span>' + escapeHTML(modelLabel(m)) + '</span>' + icon('down', 14);
    modelBtn.title = providerInfo(app.settings.provider).name + ' · ' + m;
    const busy = Boolean(app.busy);
    sendBtn.innerHTML = icon(busy ? 'stop' : 'up', 18);
    sendBtn.title = busy ? tr('중지') : tr('보내기');
    sendBtn.disabled = !busy && !ta.value.trim() && !files.length;
  }

  const el = h('div', { class: 'composer' + (big ? ' big' : '') },
    attachRow, ta,
    h('div', { class: 'composer-bar' },
      h('div', { class: 'cb-left' }, plusBtn, toolsBtn, styleChip, toolChips),
      h('div', { class: 'cb-right' }, micBtn, modelBtn, sendBtn)),
    fileInput);
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drag'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); addFiles(e.dataTransfer.files); });

  const api = { el, refresh, focus: () => ta.focus(), setText: (s) => { ta.value = s; grow(); ta.focus(); }, addFiles };
  composers.add(api);
  refresh();
  return api;
}

function escapeHTML(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function createStyleDialog() {
  const name = h('input', { type: 'text', placeholder: tr('예: 친근한 반말') });
  const prompt = h('textarea', { rows: 6, placeholder: tr('응답 방식을 설명하세요. 예: 친구처럼 반말로, 이모지 없이, 짧게 답해줘.') });
  modal(tr('스타일 만들기'), h('div', { class: 'form' }, h('label', {}, tr('이름'), name), h('label', {}, tr('지침'), prompt)), {
    actions: [{ label: tr('취소') }, {
      label: tr('만들기'), primary: true, onClick: () => {
        if (!name.value.trim() || !prompt.value.trim()) { toast(tr('이름과 지침을 입력하세요')); return false; }
        const s = { id: 'custom-' + uid(), name: name.value.trim(), desc: tr('사용자 스타일'), prompt: prompt.value.trim() };
        app.settings.customStyles.push(s);
        app.settings.style = s.id;
        persist('settings'); emit('settings');
      },
    }],
  });
}

export async function openModelPicker(anchor) {
  let provider = app.settings.provider;
  const list = h('div', { class: 'model-list' });
  const search = h('input', { type: 'search', placeholder: tr('모델 검색') });
  const provList = h('div', { class: 'prov-list' });
  const head = h('div', { class: 'mp-head' });
  let seq = 0;

  function drawProviders() {
    provList.replaceChildren(...app.config.providers.map((p) => h('button', {
      class: 'prov-item' + (p.id === provider ? ' on' : ''),
      title: p.company,
      onclick: () => { provider = p.id; search.value = ''; drawProviders(); drawModels(); },
    }, brandImg(p.icon, 18), h('span', { class: 'pi-name' }, p.name), hasKey(p.id) ? h('span', { class: 'haskey', title: tr('API 키 등록됨') }) : null)));
  }

  async function drawModels() {
    const my = ++seq;
    const info = providerInfo(provider);
    head.replaceChildren(brandImg(info.icon, 22), h('div', {}, h('b', {}, info.name), h('small', { class: 'muted' }, info.company)));
    list.replaceChildren(h('div', { class: 'muted pad' }, tr('불러오는 중...')));
    const models = await loadModels(provider);
    if (my !== seq) return;
    const q = search.value.trim().toLowerCase();
    const cur = currentModel(provider);
    list.innerHTML = '';
    if (!hasKey(provider)) {
      list.append(h('div', { class: 'notice' },
        info.publicModels ? tr('모델 목록은 키 없이도 볼 수 있지만, 대화하려면 API 키가 필요합니다. ') : tr('API 키가 없어 기본 목록을 표시합니다. '),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); closePopover(); openSettings('keys'); } }, tr('키 입력'))));
    }
    if (models.error) list.append(h('div', { class: 'notice err' }, tr('목록 오류: ') + models.error));
    const shown = models.chat.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
    shown.slice(0, 400).forEach((m) => {
      list.append(menuItem(null, m.name || m.id, () => {
        app.settings.provider = provider;
        app.settings.model[provider] = m.id;
        persist('settings');
        emit('settings');
      }, {
        desc: m.name !== m.id ? m.id : null,
        right: provider === app.settings.provider && m.id === cur ? h('span', { html: icon('check', 16) }) : '',
        leading: brandImg(modelBrand(m.id, provider), 18),
      }));
    });
    if (!shown.length) list.append(h('div', { class: 'empty small' }, tr('검색 결과가 없습니다.')));
  }

  search.addEventListener('input', drawModels);
  popover(anchor, h('div', { class: 'model-picker' }, provList, h('div', { class: 'mp-right' }, head, search, list)), { align: 'right', width: 600 });
  drawProviders();
  drawModels();
  setTimeout(() => { search.focus(); provList.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, 30);
}

// ---------- message rendering ----------
function branchNav(chat, node) {
  const key = node.parent ?? 'root';
  const sibs = kidsOf(chat, key);
  if (sibs.length < 2) return null;
  const i = sibs.indexOf(node.id);
  const go = (d) => {
    const j = i + d;
    if (j < 0 || j >= sibs.length || app.busy) return;
    chat.sel[key] = sibs[j];
    persist('chats');
    renderChatIfVisible(chat);
    if (isPanelOpenFor(chat.id)) renderPanel();
  };
  return h('span', { class: 'branch-nav' },
    iconBtn('left', tr('이전 버전'), () => go(-1), i === 0 ? 'disabled' : ''),
    h('span', {}, (i + 1) + ' / ' + sibs.length),
    iconBtn('right', tr('다음 버전'), () => go(1), i === sibs.length - 1 ? 'disabled' : ''));
}

function userEl(chat, node) {
  const wrap = h('div', { class: 'msg user', 'data-id': node.id });
  const initial = (app.settings.name || tr('나')).trim().slice(0, 1).toUpperCase();
  const filesEl = node.files?.length ? h('div', { class: 'msg-files' }, node.files.map((f) =>
    f.data && f.mimeType.startsWith('image/')
      ? h('img', { src: dataUrl(f), alt: f.name, class: 'thumb', onclick: () => modal(f.name, h('img', { src: dataUrl(f), alt: f.name, class: 'lightbox-img' }), { wide: true }) })
      : h('div', { class: 'file-card' }, h('span', { html: icon('file', 16) }), h('span', {}, h('b', {}, f.name), h('small', {}, f.text != null ? tr('{n}줄', { n: f.text.split('\n').length }) : f.mimeType))))) : null;
  const bubble = h('div', { class: 'user-bubble' }, h('span', { class: 'avatar' }, initial), h('div', { class: 'user-text' }, node.text || ''));
  const actions = h('div', { class: 'msg-actions' },
    branchNav(chat, node),
    iconBtn('copy', tr('복사'), () => copyText(node.text || '')),
    iconBtn('edit', tr('편집'), () => startEdit()));
  wrap.append(...[filesEl, node.text ? bubble : null, actions].filter(Boolean));

  function startEdit() {
    if (app.busy) return;
    const ta = h('textarea', { class: 'edit-area' });
    ta.value = node.text || '';
    const box = h('div', { class: 'edit-box' }, ta, h('div', { class: 'edit-actions' },
      h('button', { class: 'btn ghost', onclick: () => renderChatIfVisible(chat) }, tr('취소')),
      h('button', { class: 'btn primary', onclick: save }, tr('저장'))));
    function save() {
      const text = ta.value.trim();
      if (!text) return;
      const n = addNode(chat, node.parent, { role: 'user', text, files: node.files });
      persist('chats');
      generate(chat, n.id);
    }
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); } if (e.key === 'Escape') renderChatIfVisible(chat); });
    wrap.innerHTML = '';
    wrap.append(filesEl || '', box);
    ta.style.height = Math.min(ta.scrollHeight + 4, 300) + 'px';
    ta.focus();
  }
  return wrap;
}

function assistantEl(chat, node, versions) {
  const streaming = Boolean(node.streaming);
  const wrap = h('div', { class: 'msg assistant' + (streaming ? ' streaming' : ''), 'data-id': node.id });
  const body = h('div', { class: 'a-body' });
  const parts = node.parts || [];
  const lastTextIdx = parts.map((p) => p.type).lastIndexOf('text');
  const seen = {};

  parts.forEach((p, i) => {
    if (p.type === 'thought') {
      const active = streaming && i === parts.length - 1;
      const secs = node.thinkMs != null ? Math.max(1, Math.round(node.thinkMs / 1000)) : null;
      const d = h('details', { class: 'thinking' + (active ? ' active' : '') },
        h('summary', {}, h('span', { html: icon('bulb', 15) }), h('span', {}, active ? tr('생각하는 중...') : secs ? tr('{n}초 동안 생각함', { n: secs }) : tr('생각 과정')), h('span', { class: 'chev', html: icon('down', 14) })),
        renderMarkdown(p.text));
      if (active) d.open = true;
      body.append(d);
    } else if (p.type === 'text') {
      for (const seg of splitArtifacts(stripMemory(p.text))) {
        if (seg.type === 'text') {
          if (seg.text.trim()) body.append(renderMarkdown(seg.text, { cursor: streaming && i === lastTextIdx && i === parts.length - 1 }));
        } else {
          const vs = versions.get(seg.id) || [];
          seen[seg.id] = (seen[seg.id] ?? -1) + 1;
          const idx = Math.max(0, vs.findIndex((v) => v.messageId === node.id)) + seen[seg.id];
          body.append(artifactCard(chat.id, seg, idx, vs.length));
        }
      }
    } else if (p.type === 'image') {
      body.append(p.data
        ? h('figure', { class: 'gen-image' }, h('img', { src: dataUrl(p), alt: tr('생성된 이미지') }), h('a', { href: dataUrl(p), download: 'image.' + (p.mimeType.split('/')[1] || 'png') }, h('span', { html: icon('download', 14) }), tr('다운로드')))
        : h('div', { class: 'muted' }, tr('(이미지)')));
    } else if (p.type === 'code') {
      const code = h('code', { class: 'language-python' });
      code.textContent = p.code;
      try { hljs.highlightElement(code); } catch {}
      body.append(h('div', { class: 'exec' }, h('div', { class: 'exec-head', html: icon('terminal', 14) + '<span>' + escapeHTML(tr('코드 실행')) + '</span>' }), h('pre', {}, code)));
    } else if (p.type === 'codeResult') {
      body.append(h('div', { class: 'exec result' }, h('div', { class: 'exec-head' }, tr('실행 결과 · ') + (p.outcome === 'OUTCOME_OK' ? tr('성공') : p.outcome || '')), h('pre', {}, p.output || tr('(출력 없음)'))));
    }
  });

  if (streaming && !parts.length) body.append(h('div', { class: 'spark-loader', html: icon('logo', 22) }));
  if (node.sources?.length) {
    body.append(h('div', { class: 'sources' }, h('span', { class: 'muted' }, tr('출처')), node.sources.map((s, i) => h('a', {
      href: /^https?:\/\//.test(s.uri) ? s.uri : '#', target: '_blank', rel: 'noopener noreferrer', title: s.title || s.uri,
    }, h('span', { class: 'src-n' }, String(i + 1)), s.title || s.uri))));
  }
  if (node.memories?.length) {
    body.append(h('div', { class: 'memory-note' }, h('span', { html: icon('bulb', 14) }), tr('메모리에 저장함: ') + node.memories.join(' · ')));
  }
  if (node.error) body.append(h('div', { class: 'msg-error' }, node.error));
  // Offer to continue with another AI on the last reply that hit a limit.
  if (node.limit && !streaming && !node.switchedTo && !app.busy && pathOf(chat).at(-1)?.id === node.id) {
    body.append(switchActions(node.provider, (c) => { node.switchedTo = c.provider; generate(chat, node.parent, 0, node.provider); }));
  }
  if (node.handoffFrom && !streaming) body.append(h('div', { class: 'muted small switch-note' }, tr('{from} 한도에 걸려 {to}에서 대화를 이어받아 답했습니다', { from: providerInfo(node.handoffFrom).name, to: providerInfo(node.provider).name })));
  wrap.append(body);

  if (!streaming) {
    const usage = node.usage ? tr('입력 {i} · 출력 {o} 토큰', { i: node.usage.input.toLocaleString(), o: node.usage.output.toLocaleString() }) : '';
    wrap.append(h('div', { class: 'msg-actions' },
      iconBtn('copy', tr('복사'), () => copyText(assistantText(node))),
      iconBtn('refresh', tr('다시 생성'), () => { if (!app.busy) generate(chat, node.parent); }),
      branchNav(chat, node),
      h('span', { class: 'meta', title: usage }, modelLabel(node.model))));
  }
  return wrap;
}

function updateNodeEl(chat, node) {
  if (!view || view.chatId !== chat.id) return;
  const old = view.list.querySelector('[data-id="' + node.id + '"]');
  if (!old) return;
  const scroller = view.scroller;
  const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  old.replaceWith(assistantEl(chat, node, versionsFor(chat.id)));
  if (near) scroller.scrollTop = scroller.scrollHeight;
}

function renderMessages(chat) {
  const path = pathOf(chat);
  const versions = versionsFor(chat.id);
  view.list.innerHTML = '';
  path.forEach((n) => view.list.append(n.role === 'user' ? userEl(chat, n) : assistantEl(chat, n, versions)));
}

export function renderChatIfVisible(chat) {
  if (view?.chatId !== chat.id || !view.list.isConnected) return;
  const s = view.scroller;
  const near = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  renderMessages(chat);
  if (near || chat.nodes[app.busy?.nodeId]) s.scrollTop = s.scrollHeight;
}

// ---------- chat actions ----------
export async function renameChat(chat) {
  const t = await promptDialog(tr('채팅 이름 바꾸기'), chat.title);
  if (t == null || !t.trim()) return;
  chat.title = t.trim();
  chat.titled = true;
  persist('chats'); emit('chats');
  if (view?.chatId === chat.id) renderHeader(chat);
}

export async function deleteChat(chat) {
  if (!(await confirmDialog(tr('"{title}" 채팅을 삭제할까요? 되돌릴 수 없습니다.', { title: chat.title }), { okLabel: tr('삭제'), danger: true }))) return;
  if (app.busy?.chatId === chat.id) stopGeneration();
  app.chats = app.chats.filter((c) => c.id !== chat.id);
  persist('chats'); emit('chats');
  if (view?.chatId === chat.id) { closeArtifact(); location.hash = chat.projectId ? '#/project/' + chat.projectId : '#/'; }
}

export function toggleStar(chat) {
  chat.starred = !chat.starred;
  persist('chats'); emit('chats');
  if (view?.chatId === chat.id) renderHeader(chat);
}

export function exportChat(chat) {
  const md = ['# ' + chat.title, ''];
  pathOf(chat).forEach((n) => {
    md.push(n.role === 'user' ? tr('## 나') : '## AI (' + (n.model || '') + ')', '');
    md.push(n.role === 'user' ? userText(n) : assistantText(n), '');
  });
  downloadBlob((chat.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_') + '.md', new Blob([md.join('\n')], { type: 'text/markdown;charset=utf-8' }));
}

export function chatMenu(anchor, chat) {
  popover(anchor, h('div', { class: 'menu' },
    menuItem('star', chat.starred ? tr('즐겨찾기 해제') : tr('즐겨찾기'), () => toggleStar(chat)),
    menuItem('edit', tr('이름 바꾸기'), () => renameChat(chat)),
    app.projects.length ? menuItem('folder', tr('프로젝트로 이동'), () => moveToProject(chat)) : null,
    menuItem('upload', tr('공유 링크 만들기'), () => shareChat(chat, pathOf(chat).map((n) => ({ role: n.role, text: n.role === 'user' ? userText(n) : assistantText(n), model: n.model })))),
    menuItem('download', tr('마크다운으로 내보내기'), () => exportChat(chat)),
    h('div', { class: 'menu-sep' }),
    menuItem('trash', tr('삭제'), () => deleteChat(chat), { danger: true }),
  ), { align: 'right', width: 220 });
}

function moveToProject(chat) {
  const list = h('div', { class: 'menu' },
    menuItem(null, tr('프로젝트 없음'), () => { chat.projectId = null; done(); }, { right: chat.projectId ? '' : h('span', { html: icon('check', 16) }) }),
    app.projects.map((p) => menuItem('folder', p.name, () => { chat.projectId = p.id; done(); }, { right: chat.projectId === p.id ? h('span', { html: icon('check', 16) }) : '' })));
  const m = modal(tr('프로젝트로 이동'), list);
  function done() { m.close(); persist('chats'); emit('chats'); if (view?.chatId === chat.id) renderHeader(chat); toast(tr('이동했습니다')); }
}

// ---------- views ----------
function topbar(...children) {
  return h('header', { class: 'topbar' }, h('button', { class: 'icon-btn mobile-only', html: icon('menu'), 'aria-label': tr('메뉴'), onclick: () => document.body.classList.add('sidebar-open') }), ...children, usageButton());
}

function renderHeader(chat) {
  if (!view?.header) return;
  const project = projectOf(chat);
  const titleBtn = h('button', { class: 'chat-title', onclick: (e) => chatMenu(e.currentTarget, chat) }, h('span', {}, chat.title), h('span', { html: icon('down', 14) }));
  view.header.replaceChildren(topbar(
    project ? h('a', { class: 'crumb', href: '#/project/' + project.id }, h('span', { html: icon('folder', 15) }), project.name, h('span', { class: 'sep' }, '/')) : null,
    titleBtn,
    h('div', { class: 'spacer' }),
    iconBtn('star', chat.starred ? tr('즐겨찾기 해제') : tr('즐겨찾기'), () => toggleStar(chat), chat.starred ? 'starred' : ''),
  ));
}

export function renderChat(container, chatId) {
  const chat = app.chats.find((c) => c.id === chatId);
  if (!chat) { location.hash = '#/'; return; }
  if (!isPanelOpenFor(chat.id)) closeArtifact();
  const header = h('div');
  const list = h('div', { class: 'messages' });
  const scroller = h('div', { class: 'chat-scroll' }, list);
  const composer = createComposer({ onSubmit: (text, files) => sendMessage(chat, text, files), placeholder: tr('답장하기...') });
  container.replaceChildren(h('div', { class: 'chat-view' }, header, scroller, h('div', { class: 'composer-dock' }, composer.el, h('div', { class: 'disclaimer' }, tr('AI는 실수할 수 있습니다. 중요한 정보는 확인하세요.')))));
  view = { chatId: chat.id, list, scroller, header };
  renderHeader(chat);
  renderMessages(chat);
  scroller.scrollTop = scroller.scrollHeight;
  composer.focus();
}

export function leaveChat() { view = null; }

const STARTERS = {
  write: { icon: 'pen', label: tr('글쓰기'), items: [tr('정중한 회의 일정 변경 이메일을 써줘'), tr('내 서비스 소개 문구를 세 가지 톤으로 써줘'), tr('짧은 SF 소설 도입부를 써줘'), tr('자기소개서 첫 문단을 다듬어줘')] },
  learn: { icon: 'book', label: tr('학습'), items: [tr('양자 얽힘을 비유로 쉽게 설명해줘'), tr('미분과 적분의 관계를 예제로 알려줘'), tr('조선 후기 실학의 핵심을 정리해줘'), tr('영어 현재완료를 퀴즈로 연습시켜줘')] },
  code: { icon: 'code', label: tr('코드'), items: [tr('할 일 목록 웹앱을 HTML로 만들어줘'), tr('파이썬으로 CSV 파일을 분석하는 스크립트를 써줘'), tr('React로 포모도로 타이머를 만들어줘'), tr('이 정규식이 무슨 뜻인지 설명해줘: ^\\d{3}-\\d{4}$')] },
  life: { icon: 'coffee', label: tr('생활'), items: [tr('일주일 저녁 식단과 장보기 목록을 짜줘'), tr('3박 4일 제주 여행 일정을 짜줘'), tr('집중력을 높이는 아침 루틴을 추천해줘'), tr('이사 준비 체크리스트를 만들어줘')] },
  idea: { icon: 'bulb', label: tr('아이디어'), items: [tr('주말 사이드 프로젝트 아이디어 10개'), tr('카페 이름 아이디어를 브레인스토밍해줘'), tr('팀 워크숍 활동을 추천해줘'), tr('유튜브 채널 콘셉트를 제안해줘')] },
};

function greeting() {
  const hr = new Date().getHours();
  const g = hr < 5 ? tr('늦은 밤이네요') : hr < 11 ? tr('좋은 아침이에요') : hr < 17 ? tr('좋은 오후예요') : hr < 22 ? tr('좋은 저녁이에요') : tr('늦은 밤이네요');
  return app.settings.name ? tr('{greet}, {name}님', { greet: g, name: app.settings.name }) : g;
}

export function startChat(text, files, projectId = null) {
  const chat = newChat(projectId);
  chat.title = (text || files[0]?.name || tr('새 채팅')).slice(0, 40);
  location.hash = '#/chat/' + chat.id;
  sendMessage(chat, text, files);
  emit('chats');
  return chat;
}

export function renderHome(container) {
  view = null;
  closeArtifact();
  const composer = createComposer({ onSubmit: (t, f) => startChat(t, f), placeholder: tr('오늘 어떤 도움을 드릴까요?'), big: true });
  const sugg = h('div', { class: 'starter-list' });
  const chips = h('div', { class: 'starter-chips' }, Object.entries(STARTERS).map(([k, s]) => h('button', {
    class: 'chip',
    onclick: (e) => {
      const on = e.currentTarget.classList.toggle('on');
      chips.querySelectorAll('.chip').forEach((c) => c !== e.currentTarget && c.classList.remove('on'));
      sugg.replaceChildren(...(on ? s.items.map((t) => h('button', { class: 'starter', onclick: () => { composer.setText(t); sugg.replaceChildren(); chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); } }, t)) : []));
    },
  }, h('span', { html: icon(s.icon, 16) }), s.label)));
  const noKey = !app.config.providers.some((p) => hasKey(p.id));
  container.replaceChildren(h('div', { class: 'home' },
    topbar(h('div', { class: 'spacer' })),
    h('div', { class: 'home-inner' },
      h('h1', { class: 'greeting' }, h('img', { class: 'g-logo-img', src: 'img/logo.png', alt: '' }), greeting()),
      noKey ? h('div', { class: 'banner' }, tr('시작하려면 API 키가 필요합니다. '), h('button', { class: 'btn primary sm', onclick: () => openSettings('keys') }, tr('API 키 설정'))) : null,
      composer.el,
      chips,
      sugg)));
  composer.focus();
}

// shared by project page
export { createComposer as composer };
