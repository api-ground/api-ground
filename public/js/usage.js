// Per-provider usage: what this app has spent (tokens/requests per day), the latest rate-limit windows the provider
// reported, and "limit reached" state. Drives the Claude-style usage bars,
// the top-bar usage button, and switching to another AI so the work can continue.
import { app, persist, emit, on } from './state.js';
import { h, icon, popover, closePopover, menuItem, toggleSwitch } from './ui.js';
import { providerInfo, hasKey, currentModel, modelLabel, brandImg } from './api.js';
import { t as tr, locale } from './i18n.js';

const DAY_MS = 86400000;
const today = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const month = () => today().slice(0, 7);

function entry(provider) {
  app.usage ||= {};
  return (app.usage[provider] ||= { days: {} });
}

function save() { persist('usage'); emit('usage'); }

// ---------- recording ----------
export function recordUsage(provider, usage) {
  const e = entry(provider);
  const d = (e.days[today()] ||= { req: 0, input: 0, output: 0 });
  d.req += 1;
  d.input += usage?.input || 0;
  d.output += usage?.output || 0;
  e.lastUsed = Date.now();
  if (e.block && e.block.kind !== 'budget') delete e.block; // a successful call means the limit has lifted
  const cutoff = today(new Date(Date.now() - 62 * DAY_MS));
  for (const k of Object.keys(e.days)) if (k < cutoff) delete e.days[k];
  save();
}

export function recordLimits(provider, limits) {
  if (!limits?.windows?.length) return;
  entry(provider).limits = { windows: limits.windows, at: limits.at || Date.now() };
  save();
}

// err: an Error (or SSE error event) carrying { limit, message, retryAfter, limits } from the server.
export function recordLimitError(provider, err) {
  const e = entry(provider);
  if (err.limits) e.limits = err.limits;
  const now = Date.now();
  let until = err.retryAfter ? now + err.retryAfter : null;
  const resets = (err.limits?.windows || []).filter((w) => w.remaining <= 0 && w.resetAt > now).map((w) => w.resetAt);
  if (!until && resets.length) until = Math.max(...resets);
  if (!until && err.limit === 'rate') until = now + 60000;
  if (!until && err.limit === 'overloaded') until = now + 30000;
  e.block = { kind: err.limit, message: String(err.message || '').slice(0, 300), at: now, until };
  save();
}

export const isLimitError = (err) => Boolean(err?.limit);

// ---------- reading ----------
function sumDays(e, pred) {
  const out = { req: 0, input: 0, output: 0 };
  for (const [k, d] of Object.entries(e?.days || {})) {
    if (!pred(k)) continue;
    out.req += d.req; out.input += d.input; out.output += d.output;
  }
  out.tokens = out.input + out.output;
  return out;
}
export const todayTotals = (p) => sumDays(app.usage?.[p], (k) => k === today());
export const monthTotals = (p) => sumDays(app.usage?.[p], (k) => k.startsWith(month()));

const budgetOf = (p) => Number(app.settings.budgets?.[p]) || 0;

const WINDOW_LABEL = {
  requests: () => tr('요청 수'), tokens: () => tr('토큰'), input: () => tr('입력 토큰'), output: () => tr('출력 토큰'),
};
const PERIOD_LABEL = { minute: () => tr('분당'), hour: () => tr('시간당'), day: () => tr('일일') };
export function windowLabel(w) {
  return [w.period ? PERIOD_LABEL[w.period]() : '', WINDOW_LABEL[w.kind]?.() || w.kind].filter(Boolean).join(' ');
}

// A window is only meaningful until it resets; after that the provider has refilled it.
function liveWindows(p) {
  const l = app.usage?.[p]?.limits;
  if (!l) return [];
  const now = Date.now();
  return l.windows.filter((w) => (w.resetAt ? w.resetAt > now : now - l.at < 60000));
}
const usedPct = (w) => Math.max(0, Math.min(100, Math.round((1 - w.remaining / w.limit) * 100)));

// { level: 'ok' | 'warn' | 'blocked', text, resetAt }
export function limitStatus(p) {
  const name = providerInfo(p).name;
  const now = Date.now();
  const b = app.usage?.[p]?.block;
  if (b && (b.until ? b.until > now : b.kind === 'quota' && now - b.at < DAY_MS)) {
    const text = b.kind === 'quota' ? tr('{name} 크레딧 또는 사용 한도를 모두 썼습니다', { name })
      : b.kind === 'overloaded' ? tr('{name} 서버가 혼잡합니다', { name })
      : tr('{name} 사용 한도에 도달했습니다', { name });
    return { level: 'blocked', text, resetAt: b.until };
  }
  const budget = budgetOf(p);
  if (budget) {
    const pct = Math.round((monthTotals(p).tokens / budget) * 100);
    if (pct >= 100) return { level: 'blocked', text: tr('{name} 이번 달 예산을 모두 썼습니다', { name }), resetAt: null, budget: true };
    if (pct >= 90) return { level: 'warn', text: tr('{name} 이번 달 예산의 {pct}%를 썼습니다', { name, pct }) };
  }
  const hot = liveWindows(p).map((w) => ({ w, pct: usedPct(w) })).sort((a, b) => b.pct - a.pct)[0];
  if (hot && hot.pct >= 100) return { level: 'blocked', text: tr('{name} {what} 한도에 도달했습니다', { name, what: windowLabel(hot.w) }), resetAt: hot.w.resetAt };
  if (hot && hot.pct >= 85) return { level: 'warn', text: tr('{name} {what} 한도의 {pct}%를 썼습니다', { name, what: windowLabel(hot.w), pct: hot.pct }), resetAt: hot.w.resetAt };
  return { level: 'ok' };
}

export function fmtReset(at) {
  if (!at) return '';
  const ms = at - Date.now();
  if (ms <= 0) return tr('곧 초기화');
  if (ms < 60000) return tr('{n}초 후 초기화', { n: Math.ceil(ms / 1000) });
  if (ms < 3600000) return tr('{n}분 후 초기화', { n: Math.ceil(ms / 60000) });
  if (ms < DAY_MS) return tr('{n}시간 후 초기화', { n: Math.round(ms / 3600000) });
  return tr('{date} 초기화', { date: new Date(at).toLocaleDateString(locale()) });
}

const fmtNum = (n) => Number(n || 0).toLocaleString(locale());

// ---------- switching ----------
// Providers to continue with: the user has a key, not currently limited; recently used ones first.
export function fallbackCandidates(exclude) {
  const order = new Map(app.config.providers.map((p, i) => [p.id, i]));
  return app.config.providers
    .filter((p) => p.id !== exclude && hasKey(p.id) && limitStatus(p.id).level !== 'blocked')
    .sort((a, b) => (app.usage?.[b.id]?.lastUsed || 0) - (app.usage?.[a.id]?.lastUsed || 0) || order.get(a.id) - order.get(b.id))
    .map((p) => ({ provider: p.id, model: currentModel(p.id) }));
}

export function switchTo(provider) {
  app.settings.provider = provider;
  persist('settings');
  emit('settings');
}

const targetLabel = (c) => modelLabel(c.model) || providerInfo(c.provider).name;

// Buttons shown with a limit error: continue with the best other AI, pick another, or open usage.
export function switchActions(current, onPick) {
  const cands = fallbackCandidates(current);
  const wrap = h('div', { class: 'limit-actions' });
  if (!cands.length) {
    wrap.append(h('span', { class: 'muted small' }, tr('이어서 쓸 다른 AI가 없습니다. 설정 → API 키에서 다른 공급자의 키를 추가하세요.')),
      h('button', { class: 'btn small', onclick: () => import('./settings.js').then((m) => m.openSettings('keys')) }, tr('API 키 추가')));
    return wrap;
  }
  const first = cands[0];
  const pick = (c) => { closePopover(); switchTo(c.provider); onPick(c); };
  const more = h('button', { class: 'btn small' }, tr('다른 AI 선택'), h('span', { html: icon('down', 12) }));
  more.addEventListener('click', () => popover(more, h('div', { class: 'menu' },
    h('div', { class: 'menu-label' }, tr('대화 내용을 그대로 가져가 이어갑니다')),
    ...cands.map((c) => menuItem(null, providerInfo(c.provider).name, () => pick(c), { desc: c.model, right: brandImg(providerInfo(c.provider).icon, 16) }))), { width: 280 }));
  wrap.append(
    h('button', { class: 'btn small primary', onclick: () => pick(first) }, brandImg(providerInfo(first.provider).icon, 14), tr('{model} 모델로 이어서 하기', { model: targetLabel(first) })),
    more,
    h('button', { class: 'btn small ghost', onclick: () => import('./settings.js').then((m) => m.openSettings('usage')) }, tr('사용량 보기')));
  return wrap;
}

// Top-bar usage button (Claude-style): a small gauge with a dot when a provider is near (orange) or at (red)
// its limit; clicking opens a popup with the usage bars.
function worstLevel() {
  const ids = app.config.providers.filter((p) => hasKey(p.id)).map((p) => p.id);
  const levels = ids.map((id) => limitStatus(id).level);
  return levels.includes('blocked') ? 'blocked' : levels.includes('warn') ? 'warn' : 'ok';
}

function popupRow(p) {
  const info = providerInfo(p);
  const st = limitStatus(p);
  const rows = [];
  for (const w of liveWindows(p)) {
    const pct = usedPct(w);
    rows.push(h('div', { class: 'urow' },
      h('div', { class: 'urow-top' }, h('span', {}, windowLabel(w)), h('span', { class: 'muted' }, tr('{pct}% 사용', { pct }))),
      bar(pct, levelFor(pct)),
      w.resetAt ? h('small', { class: 'muted' }, fmtReset(w.resetAt)) : null));
  }
  const budget = budgetOf(p);
  if (budget) {
    const pct = Math.round((monthTotals(p).tokens / budget) * 100);
    rows.push(h('div', { class: 'urow' },
      h('div', { class: 'urow-top' }, h('span', {}, tr('이번 달 예산')), h('span', { class: 'muted' }, tr('{pct}% 사용', { pct }))),
      bar(pct, levelFor(pct))));
  }
  if (!rows.length) rows.push(h('small', { class: 'muted' }, st.level === 'blocked' ? '' : tr('이번 달 {n} 토큰 사용', { n: fmtNum(monthTotals(p).tokens) })));
  return h('div', { class: 'upop-item' + (p === app.settings.provider ? ' current' : '') },
    h('div', { class: 'upop-head' }, brandImg(info.icon, 16), h('b', {}, info.name), st.level !== 'ok' ? h('span', { class: 'ubadge ' + st.level }, st.level === 'blocked' ? tr('한도 도달') : tr('한도 임박')) : null),
    st.level !== 'ok' ? h('div', { class: 'ustatus ' + st.level }, st.text + (st.resetAt ? ' · ' + fmtReset(st.resetAt) : '')) : null,
    ...rows);
}

function openUsagePopup(anchor) {
  const cur = app.settings.provider;
  const ids = [cur, ...app.config.providers.filter((p) => p.id !== cur && hasKey(p.id) && (app.usage?.[p.id] || limitStatus(p.id).level !== 'ok')).map((p) => p.id)];
  const st = limitStatus(cur);
  popover(anchor, h('div', { class: 'upop' },
    h('div', { class: 'upop-title' }, tr('사용 한도')),
    ...ids.map(popupRow),
    st.level === 'blocked' ? switchActions(cur, () => {}) : null,
    h('button', { class: 'link-btn upop-more', onclick: () => { closePopover(); import('./settings.js').then((m) => m.openSettings('usage')); } }, tr('사용량 자세히 보기'))), { align: 'right', width: 320 });
}

export function usageButton() {
  const dot = h('span', { class: 'ubtn-dot' });
  const btn = h('button', { class: 'icon-btn usage-btn', title: tr('사용 한도'), 'aria-label': tr('사용 한도'), html: icon('gauge') });
  btn.append(dot);
  const draw = () => { const lv = worstLevel(); dot.className = 'ubtn-dot ' + lv; dot.hidden = lv === 'ok'; };
  btn.addEventListener('click', () => openUsagePopup(btn));
  const off = on((evt) => { if (!btn.isConnected) { off(); return; } if (evt === 'usage' || evt === 'settings') draw(); });
  draw();
  return btn;
}

// Re-render countdowns while any provider is limited.
setInterval(() => {
  if (!app.usage) return;
  if (Object.keys(app.usage).some((p) => limitStatus(p).level !== 'ok')) emit('usage');
}, 30000);

// ---------- settings tab ----------
function bar(pct, level) {
  return h('div', { class: 'ubar' + (level ? ' ' + level : '') }, h('span', { style: 'width:' + Math.max(0, Math.min(100, pct)) + '%' }));
}
const levelFor = (pct) => (pct >= 100 ? 'blocked' : pct >= 85 ? 'warn' : '');

function providerCard(p) {
  const info = providerInfo(p);
  const st = limitStatus(p);
  const m = monthTotals(p);
  const d = todayTotals(p);
  const card = h('div', { class: 'ucard' });
  const badge = h('span', { class: 'ubadge ' + st.level }, st.level === 'blocked' ? tr('한도 도달') : st.level === 'warn' ? tr('한도 임박') : tr('사용 가능'));
  card.append(h('div', { class: 'ucard-head' }, brandImg(info.icon, 22), h('div', { class: 'kr-name' }, h('b', {}, info.name), h('small', { class: 'muted' }, modelLabel(currentModel(p)))), badge));
  if (st.level !== 'ok') card.append(h('div', { class: 'ustatus ' + st.level }, st.text + (st.resetAt ? ' · ' + fmtReset(st.resetAt) : '')));

  // provider-reported rate-limit windows
  const l = app.usage?.[p]?.limits;
  const live = liveWindows(p);
  if (live.length) {
    card.append(h('div', { class: 'usub' }, tr('공급자 한도'), h('small', { class: 'muted' }, ' · ' + tr('마지막 확인 {time}', { time: new Date(l.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }))));
    for (const w of live) {
      const pct = usedPct(w);
      card.append(h('div', { class: 'urow' },
        h('div', { class: 'urow-top' }, h('span', {}, windowLabel(w)), h('span', { class: 'muted' }, tr('{pct}% 사용', { pct }) + (w.resetAt ? ' · ' + fmtReset(w.resetAt) : ''))),
        bar(pct, levelFor(pct)),
        h('small', { class: 'muted' }, tr('{remaining} / {limit} 남음', { remaining: fmtNum(w.remaining), limit: fmtNum(w.limit) }))));
    }
  } else {
    card.append(h('small', { class: 'muted unote' }, l ? tr('한도가 초기화되었습니다. 다음 요청 때 다시 확인합니다.')
      : info.type === 'gemini' ? tr('Gemini는 남은 한도를 알려주지 않습니다. 아래 월 예산으로 한도를 직접 정할 수 있습니다.')
      : tr('아직 확인된 한도 정보가 없습니다. 한 번 대화하면 공급자가 알려준 한도가 표시됩니다.')));
  }

  // this app's own usage + optional monthly budget
  const budget = budgetOf(p);
  const input = h('input', { type: 'number', min: 0, step: 10000, placeholder: tr('없음'), value: budget || '' });
  input.addEventListener('change', () => {
    const v = Math.max(0, Math.round(Number(input.value) || 0));
    app.settings.budgets ||= {};
    if (v) app.settings.budgets[p] = v; else delete app.settings.budgets[p];
    persist('settings');
    emit('usage');
    card.replaceWith(providerCard(p));
  });
  card.append(h('div', { class: 'usub' }, tr('이 앱에서 쓴 양')));
  if (budget) {
    const pct = Math.round((m.tokens / budget) * 100);
    card.append(h('div', { class: 'urow' },
      h('div', { class: 'urow-top' }, h('span', {}, tr('이번 달 예산')), h('span', { class: 'muted' }, tr('{pct}% 사용', { pct }) + ' · ' + tr('다음 달 1일 초기화'))),
      bar(pct, levelFor(pct)),
      h('small', { class: 'muted' }, tr('{used} / {limit} 토큰', { used: fmtNum(m.tokens), limit: fmtNum(budget) }))));
  }
  card.append(h('div', { class: 'ustats' },
    h('div', {}, h('small', { class: 'muted' }, tr('오늘')), h('b', {}, tr('{n} 토큰', { n: fmtNum(d.tokens) })), h('small', { class: 'muted' }, tr('요청 {n}회', { n: fmtNum(d.req) }))),
    h('div', {}, h('small', { class: 'muted' }, tr('이번 달')), h('b', {}, tr('{n} 토큰', { n: fmtNum(m.tokens) })), h('small', { class: 'muted' }, tr('입력 {i} · 출력 {o}', { i: fmtNum(m.input), o: fmtNum(m.output) })))),
    h('div', { class: 'ubudget' }, h('span', {}, tr('월 토큰 예산')), input));
  return card;
}

export function usageTab() {
  const s = app.settings;
  const providers = app.config.providers.filter((p) => hasKey(p.id) || app.usage?.[p.id]);
  const list = h('div', { class: 'ucards' }, providers.length ? providers.map((p) => providerCard(p.id)) : [h('div', { class: 'empty small' }, tr('API 키를 등록하면 공급자별 사용량과 한도가 여기에 표시됩니다.'))]);
  const off = on((evt) => {
    if (!list.isConnected) { off(); return; }
    if (evt === 'usage' && !list.contains(document.activeElement)) list.replaceChildren(...providers.map((p) => providerCard(p.id)));
  });
  return h('div', { class: 'form' },
    h('div', { class: 'setting-row' },
      h('div', {}, h('b', {}, tr('한도에 걸리면 자동으로 다른 AI로 전환')), h('small', { class: 'muted' }, tr('사용 한도나 크레딧이 떨어지면 키가 있는 다른 AI가 지금까지의 대화와 작업 내용을 그대로 이어받아 계속합니다. 꺼 두면 전환 버튼만 표시합니다.'))),
      toggleSwitch(Boolean(s.autoSwitch), (v) => { s.autoSwitch = v; persist('settings'); emit('settings'); })),
    h('p', { class: 'muted small' }, tr('공급자 한도는 각 API가 응답과 함께 알려준 값이고, 사용량은 이 기기에서 보낸 요청만 셉니다. 실제 요금은 각 공급자 콘솔에서 확인하세요.')),
    list);
}
