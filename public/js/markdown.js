import { h } from './ui.js';
import { t as tr } from './i18n.js';

marked.setOptions({ gfm: true, breaks: true });

const CODE_SPLIT = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;

function protectMath(text, store) {
  if (typeof katex === 'undefined') return text;
  return text.split(CODE_SPLIT).map((seg, i) => {
    if (i % 2 === 1) return seg;
    return seg.replace(MATH, (m, block1, block2, inline1, inline2) => {
      const display = block1 != null || block2 != null;
      const tex = block1 ?? block2 ?? inline1 ?? inline2;
      try {
        store.push(katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false }));
        return (display ? '\n\n' : '') + 'KTXMATH' + (store.length - 1) + 'X' + (display ? '\n\n' : '');
      } catch { return m; }
    });
  }).join('');
}

export function renderMarkdownHTML(text) {
  const math = [];
  let html = DOMPurify.sanitize(marked.parse(protectMath(text || '', math)));
  if (math.length) html = html.replace(/KTXMATH(\d+)X/g, (_, i) => math[+i] ?? '');
  return html;
}

export function renderMarkdown(text, { cursor = false } = {}) {
  const div = h('div', { class: 'md' });
  div.innerHTML = renderMarkdownHTML(text);
  div.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  div.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || '';
    try { hljs.highlightElement(code); } catch {}
    const btn = h('button', { class: 'code-copy' }, tr('복사'));
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(code.innerText);
      btn.textContent = tr('복사됨');
      setTimeout(() => { btn.textContent = tr('복사'); }, 1200);
    });
    pre.prepend(h('div', { class: 'code-head' }, h('span', {}, lang || 'code'), btn));
  });
  if (cursor) {
    const last = div.lastElementChild;
    (last && !last.matches('pre, table, ul, ol') ? last : div).appendChild(h('span', { class: 'cursor' }));
  }
  return div;
}
