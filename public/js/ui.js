import { t as tr, locale } from './i18n.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  gauge: '<path d="M4.5 16.5a8.5 8.5 0 1 1 15 0"/><path d="M12 13.5l3.5-4"/><circle cx="12" cy="14" r="1.2" fill="currentColor"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
  pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  book: '<path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>',
  coffee: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h2a2 2 0 0 1 0 4h-2M8 3v3M12 3v3"/>',
  spark: '<path d="M12 2c.8 5.6 4.4 9.2 10 10-5.6.8-9.2 4.4-10 10-.8-5.6-4.4-9.2-10-10 5.6-.8 9.2-4.4 10-10z"/>',
  logo: '<path d="M12 2c.8 5.6 4.4 9.2 10 10-5.6.8-9.2 4.4-10 10-.8-5.6-4.4-9.2-10-10 5.6-.8 9.2-4.4 10-10z" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  pin: '<path d="M12 17v5M5 17h14l-2-4V5H7v8z"/>',
};

export function icon(name, size = 18) {
  return '<svg class="ico" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
}

export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, html: icon(name), onclick });
}

export function toast(msg) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', class: 'toast' }); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

let openPop = null;
export function closePopover() {
  if (openPop) { openPop.el.remove(); document.removeEventListener('mousedown', openPop.outside, true); document.removeEventListener('keydown', openPop.key, true); openPop = null; }
}

export function popover(anchor, content, { align = 'left', place = 'auto', width } = {}) {
  closePopover();
  const el = h('div', { class: 'popover' }, content);
  if (width) el.style.width = Math.min(width, window.innerWidth - 16) + 'px';
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  const spaceBelow = window.innerHeight - r.bottom;
  const above = place === 'above' || (place === 'auto' && spaceBelow < pr.height + 12 && r.top > spaceBelow);
  let left = align === 'right' ? r.right - pr.width : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  el.style.left = left + 'px';
  el.style.top = (above ? Math.max(8, r.top - pr.height - 6) : r.bottom + 6) + 'px';
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', key, true);
  openPop = { el, outside, key };
  return el;
}

export function menuItem(iconName, label, onclick, opts = {}) {
  return h('button', {
    class: 'menu-item' + (opts.active ? ' active' : '') + (opts.danger ? ' danger' : ''),
    onclick: (e) => { if (!opts.keepOpen) closePopover(); onclick(e); },
  },
  iconName ? h('span', { class: 'mi-icon', html: icon(iconName, 16) }) : opts.leading || null,
  h('span', { class: 'mi-label' }, label, opts.desc ? h('small', {}, opts.desc) : null),
  opts.right != null ? (typeof opts.right === 'string' ? h('span', { class: 'mi-right' }, opts.right) : opts.right) : null);
}

export function toggleSwitch(checked, onchange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onchange(input.checked));
  return h('label', { class: 'switch', onclick: (e) => e.stopPropagation() }, input, h('span'));
}

export function modal(title, body, { actions = [], wide = false, onClose } = {}) {
  const dlg = h('dialog', { class: 'modal' + (wide ? ' wide' : '') });
  const close = () => { dlg.close(); dlg.remove(); onClose && onClose(); };
  dlg.append(
    h('div', { class: 'modal-head' }, h('h3', {}, title), iconBtn('x', tr('닫기'), close)),
    h('div', { class: 'modal-body' }, body),
  );
  if (actions.length) {
    dlg.append(h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
      class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : 'ghost'),
      onclick: () => { if (a.onClick && a.onClick() === false) return; close(); },
    }, a.label))));
  }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

export function confirmDialog(message, { okLabel = tr('확인'), danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    modal(tr('확인'), h('p', {}, message), {
      actions: [{ label: tr('취소') }, { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } }],
      onClose: () => resolve(ok),
    });
  });
}

export function promptDialog(title, value = '', { multiline = false, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline ? h('textarea', { rows: 6, placeholder }) : h('input', { type: 'text', placeholder });
    input.value = value;
    const m = modal(title, input, {
      actions: [{ label: tr('취소') }, { label: tr('저장'), primary: true, onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { result = input.value; m.close(); } });
    setTimeout(() => { input.focus(); input.select?.(); }, 30);
  });
}

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return tr('방금');
  if (s < 3600) return tr('{n}분 전', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('{n}시간 전', { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return tr('{n}일 전', { n: Math.floor(s / 86400) });
  return new Date(ts).toLocaleDateString(locale());
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml|sql))/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|html|htm|css|scss|xml|yml|yaml|toml|ini|sh|bat|ps1|sql|log|env|vue|svelte)$/i;

export function isTextFile(f) {
  return TEXT_TYPES.test(f.mimeType || '') || TEXT_EXT.test(f.name || '');
}

export const MAX_FILE = 20 * 1024 * 1024;

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const base = { name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size };
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    if (isTextFile(base)) {
      reader.onload = () => resolve({ ...base, mimeType: base.mimeType.startsWith('text/') ? base.mimeType : 'text/plain', text: String(reader.result) });
      reader.readAsText(file);
    } else {
      reader.onload = () => resolve({ ...base, data: String(reader.result).split(',')[1] });
      reader.readAsDataURL(file);
    }
  });
}

export function dataUrl(f) { return 'data:' + f.mimeType + ';base64,' + f.data; }

export function downloadBlob(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function copyText(text, msg = tr('복사되었습니다')) {
  navigator.clipboard.writeText(text).then(() => toast(msg), () => toast(tr('복사하지 못했습니다')));
}
