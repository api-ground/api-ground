import { h, icon, iconBtn, copyText, downloadBlob, esc } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { t as tr } from './i18n.js';

export const ARTIFACT_PROMPT = `# Artifacts
You can create "artifacts": substantial, self-contained content shown to the user in a separate panel next to the chat.

Use an artifact when the content is longer than ~15 lines AND is something the user will likely reuse, edit, run or view on its own: full programs or code files, HTML pages or apps, React components, SVG graphics, Mermaid diagrams, long documents (reports, articles, stories, plans). Do NOT use artifacts for short code snippets, brief answers, explanations, or conversational replies.

Syntax (exactly this form, no markdown code fences around it):
<artifact identifier="kebab-case-id" type="TYPE" title="Short title" language="LANG">
...full content...
</artifact>

TYPE must be one of:
- text/html : a complete single-file HTML page (inline CSS/JS; external scripts only from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net)
- application/vnd.react : one React function component with \`export default\`. Only React (hooks via \`import { useState } from 'react'\`) and Tailwind CSS classes are available; no other libraries.
- image/svg+xml : a single <svg> element with a viewBox
- application/vnd.mermaid : Mermaid diagram source
- text/markdown : a document
- application/vnd.code : source code; set language (e.g. python, javascript)

Rules:
- One artifact per response unless the user asks for more. Put a short sentence before it and, if useful, a brief note after it.
- To update an existing artifact, output it again with the SAME identifier and the COMPLETE new content (never partial diffs).
- Never wrap the artifact tag in \`\`\` fences, and do not put \`\`\` fences inside the artifact content.`;

const OPEN_RE = /<artifact\b([^>]*)>/i;

function attrs(s) {
  const out = {};
  s.replace(/([\w-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { out[k.toLowerCase()] = v; });
  return out;
}

function stripFences(s) {
  let c = s.replace(/^\s*\n/, '');
  const m = c.match(/^\s*```[\w+-]*\s*\n([\s\S]*?)\n?\s*(```\s*)?$/);
  if (m) c = m[1];
  return c.replace(/\s+$/, '');
}

export function splitArtifacts(text) {
  const out = [];
  let rest = text || '';
  while (rest) {
    const m = rest.match(OPEN_RE);
    if (!m) {
      // hide a half-streamed opening tag at the very end
      const partial = rest.match(/<(a(r(t(i(f(a(c(t\b[^>]*)?)?)?)?)?)?)?)?$/i);
      out.push({ type: 'text', text: partial ? rest.slice(0, partial.index) : rest });
      break;
    }
    const before = rest.slice(0, m.index).replace(/```\w*\s*$/, '');
    if (before.trim()) out.push({ type: 'text', text: before });
    const a = attrs(m[1]);
    const after = rest.slice(m.index + m[0].length);
    const end = after.search(/<\/artifact>/i);
    const raw = end >= 0 ? after.slice(0, end) : after.replace(/<\/a(r(t(i(f(a(c(t)?)?)?)?)?)?)?$/i, '');
    out.push({
      type: 'artifact',
      id: a.identifier || 'artifact',
      kind: a.type || 'application/vnd.code',
      title: a.title || tr('아티팩트'),
      language: a.language || '',
      content: stripFences(raw),
      complete: end >= 0,
    });
    rest = end >= 0 ? after.slice(end + '</artifact>'.length).replace(/^\s*```/, '') : '';
  }
  return out;
}

// messages: [{id, text, streaming}] in conversation order
export function collectVersions(messages) {
  const map = new Map();
  for (const m of messages) {
    for (const seg of splitArtifacts(m.text)) {
      if (seg.type !== 'artifact') continue;
      if (!map.has(seg.id)) map.set(seg.id, []);
      map.get(seg.id).push({ ...seg, messageId: m.id, streaming: m.streaming && !seg.complete });
    }
  }
  return map;
}

const KIND_LABEL = {
  'text/html': 'HTML', 'application/vnd.react': 'React', 'image/svg+xml': 'SVG',
  'application/vnd.mermaid': tr('다이어그램'), 'text/markdown': tr('문서'), 'application/vnd.code': tr('코드'),
};
const PREVIEWABLE = new Set(['text/html', 'application/vnd.react', 'image/svg+xml', 'application/vnd.mermaid', 'text/markdown']);
const EXT = { 'text/html': 'html', 'application/vnd.react': 'jsx', 'image/svg+xml': 'svg', 'application/vnd.mermaid': 'mmd', 'text/markdown': 'md' };
const LANG_EXT = { python: 'py', javascript: 'js', typescript: 'ts', java: 'java', go: 'go', rust: 'rs', c: 'c', cpp: 'cpp', csharp: 'cs', ruby: 'rb', php: 'php', bash: 'sh', shell: 'sh', sql: 'sql', css: 'css', json: 'json', kotlin: 'kt', swift: 'swift' };

export const kindLabel = (k) => KIND_LABEL[k] || tr('코드');

function fileName(v) {
  const base = (v.title || v.id).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '') || 'artifact';
  return base + '.' + (EXT[v.kind] || LANG_EXT[(v.language || '').toLowerCase()] || 'txt');
}

const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script');

function reactDoc(src) {
  let name = null;
  let code = src.replace(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (m, what, mod) => {
    if (mod === 'react') {
      const named = (what.match(/\{([^}]*)\}/) || [])[1];
      return named ? 'const {' + named.replace(/\s+as\s+/g, ': ') + '} = React;' : '';
    }
    if (mod.startsWith('react-dom')) return '';
    return '/* unsupported import: ' + mod + ' */';
  }).replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/export\s+default\s+function\s+(\w+)/, (m, n) => { name = n; return 'function ' + n; });
  if (!name) code = code.replace(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m, (m, n) => { name = n; return ''; });
  if (!name) code = code.replace(/export\s+default\s+/, () => { name = '__Default'; return 'const __Default = '; });
  code = code.replace(/^export\s+/gm, '');
  code += '\nReactDOM.createRoot(document.getElementById("root")).render(React.createElement(' + (name || 'App') + '));';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<script src="https://cdn.tailwindcss.com"><\/script>'
    + '<script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"><\/script>'
    + '<script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"><\/script>'
    + '<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.24.7/babel.min.js"><\/script>'
    + '<script>window.addEventListener("error",function(e){var p=document.createElement("pre");p.style.cssText="color:#b42318;white-space:pre-wrap;padding:12px;font:13px monospace";p.textContent=' + JSON.stringify(tr('오류: ')) + '+(e.message||e.error);document.body.appendChild(p)})<\/script>'
    + '</head><body><div id="root"></div><script type="text/babel" data-presets="react">' + safeScript(code) + '<\/script></body></html>';
}

export function previewDoc(kind, content) {
  switch (kind) {
    case 'text/html':
      return /<html|<body|<!doctype/i.test(content) ? content : '<!doctype html><meta charset="utf-8"><body>' + content;
    case 'image/svg+xml':
      return '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style>' + content;
    case 'application/vnd.mermaid':
      return '<!doctype html><meta charset="utf-8"><body style="margin:16px;background:#fff"><pre class="mermaid">' + esc(content)
        + '</pre><script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"><\/script><script>mermaid.initialize({startOnLoad:true})<\/script>';
    case 'application/vnd.react':
      return reactDoc(content);
    default:
      return '';
  }
}

export function sandboxFrame(doc, cls = 'preview-frame') {
  const f = h('iframe', { class: cls, sandbox: 'allow-scripts allow-modals allow-forms allow-popups', referrerpolicy: 'no-referrer' });
  f.srcdoc = doc;
  return f;
}

function codeView(content, language) {
  const code = h('code', { class: language ? 'language-' + language.toLowerCase() : '' });
  code.textContent = content;
  try { if (content.length < 200000) hljs.highlightElement(code); } catch {}
  return h('pre', { class: 'artifact-code' }, code);
}

// ---------- panel ----------
const panel = { chatId: null, id: null, version: null, tab: 'preview', getVersions: null, key: '' };

export function setVersionProvider(fn) { panel.getVersions = fn; }
export const isPanelOpenFor = (chatId) => panel.chatId === chatId && Boolean(panel.id);

export function openArtifact(chatId, id, version = null) {
  panel.chatId = chatId;
  panel.id = id;
  panel.version = version;
  panel.tab = 'preview';
  panel.key = '';
  document.body.classList.add('artifact-open');
  renderPanel();
}

export function closeArtifact() {
  panel.id = null;
  panel.chatId = null;
  panel.key = '';
  document.body.classList.remove('artifact-open');
  const el = document.getElementById('artifactPanel');
  el.innerHTML = '';
}

export function renderPanel() {
  const el = document.getElementById('artifactPanel');
  if (!panel.id || !panel.getVersions) return;
  const versions = panel.getVersions(panel.chatId)?.get(panel.id);
  if (!versions?.length) { closeArtifact(); return; }
  const idx = panel.version == null ? versions.length - 1 : Math.min(panel.version, versions.length - 1);
  const v = versions[idx];
  const canPreview = PREVIEWABLE.has(v.kind);
  const tab = !canPreview || v.streaming ? 'code' : panel.tab;
  const key = [panel.id, idx, tab, v.kind, v.content.length, v.streaming].join('|');
  const body = el.querySelector('.ap-body');
  if (key === panel.key && body) return;
  const streamingOnly = panel.key.split('|').slice(0, 4).join('|') === key.split('|').slice(0, 4).join('|') && v.streaming && body;
  panel.key = key;

  if (streamingOnly) {
    const code = body.querySelector('code');
    if (code) { code.textContent = v.content; body.scrollTop = body.scrollHeight; return; }
  }

  const go = (d) => { panel.version = Math.max(0, Math.min(versions.length - 1, idx + d)); panel.key = ''; renderPanel(); };
  const setTab = (t) => { panel.tab = t; panel.key = ''; renderPanel(); };
  el.innerHTML = '';
  el.append(
    h('div', { class: 'ap-head' },
      h('div', { class: 'ap-title' },
        h('strong', {}, v.title),
        h('span', { class: 'muted' }, kindLabel(v.kind) + (v.streaming ? tr(' · 생성 중...') : ''))),
      versions.length > 1 ? h('div', { class: 'ver-nav' },
        iconBtn('left', tr('이전 버전'), () => go(-1), idx === 0 ? 'disabled' : ''),
        h('span', {}, 'v' + (idx + 1) + ' / ' + versions.length),
        iconBtn('right', tr('다음 버전'), () => go(1), idx === versions.length - 1 ? 'disabled' : '')) : null,
      canPreview ? h('div', { class: 'seg' },
        h('button', { class: tab === 'preview' ? 'on' : '', onclick: () => setTab('preview'), disabled: v.streaming }, tr('미리보기')),
        h('button', { class: tab === 'code' ? 'on' : '', onclick: () => setTab('code') }, tr('코드'))) : null,
      iconBtn('copy', tr('복사'), () => copyText(v.content)),
      iconBtn('download', tr('다운로드'), () => downloadBlob(fileName(v), new Blob([v.content], { type: 'text/plain;charset=utf-8' }))),
      iconBtn('x', tr('닫기'), closeArtifact)),
  );
  let content;
  if (tab === 'code') content = codeView(v.content, v.kind === 'application/vnd.code' ? v.language : (EXT[v.kind] === 'jsx' ? 'javascript' : EXT[v.kind] === 'md' ? 'markdown' : EXT[v.kind] === 'svg' ? 'xml' : EXT[v.kind] || ''));
  else if (v.kind === 'text/markdown') content = h('div', { class: 'artifact-doc' }, renderMarkdown(v.content));
  else content = sandboxFrame(previewDoc(v.kind, v.content));
  const newBody = h('div', { class: 'ap-body' + (tab === 'code' ? ' code' : '') }, content);
  el.append(newBody);
  if (v.streaming) newBody.scrollTop = newBody.scrollHeight;
}

export function artifactCard(chatId, seg, versionIndex, total) {
  return h('button', {
    class: 'artifact-card' + (seg.complete ? '' : ' loading'),
    onclick: () => openArtifact(chatId, seg.id, versionIndex),
  },
  h('span', { class: 'ac-icon', html: icon(seg.kind === 'text/markdown' ? 'file' : seg.kind === 'image/svg+xml' || seg.kind === 'application/vnd.mermaid' ? 'eye' : 'code', 20) }),
  h('span', { class: 'ac-text' },
    h('strong', {}, seg.title),
    h('small', {}, seg.complete ? kindLabel(seg.kind) + (total > 1 ? tr(' · 버전 {n}', { n: versionIndex + 1 }) : '') + tr(' · 클릭하여 열기') : tr('생성 중...'))));
}
