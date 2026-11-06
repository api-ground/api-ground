// Usage limits: normalizes provider rate-limit headers and classifies "limit reached" errors, so the client can show Claude-style usage bars and switch to another AI when one runs out.

// window: { kind: 'requests'|'tokens'|'input'|'output', period: 'minute'|'hour'|'day'|null, limit, remaining, resetAt }
export function parseLimits(headers) {
  if (!headers) return null;
  const map = new Map();
  const slot = (kind, period) => {
    const k = kind + ':' + (period || '');
    if (!map.has(k)) map.set(k, { kind, period: period || null });
    return map.get(k);
  };
  const now = Date.now();
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase();
    let m;
    let kind, field, period = null;
    if ((m = name.match(/^anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-(limit|remaining|reset)$/))) {
      kind = { 'input-tokens': 'input', 'output-tokens': 'output' }[m[1]] || m[1];
      field = m[2];
      period = 'minute';
    } else if ((m = name.match(/^x-ratelimit-(limit|remaining|reset)-(requests|tokens)(?:-(minute|hour|day))?$/))) {
      field = m[1]; kind = m[2]; period = m[3] || null;
    } else if ((m = name.match(/^x-ratelimit-(requests|tokens)-(limit|remaining|reset)$/))) {
      kind = m[1]; field = m[2];
    } else if ((m = name.match(/^x-ratelimit-(limit|remaining|reset)$/))) {
      kind = 'requests'; field = m[1];
    } else continue;
    const s = slot(kind, period);
    if (field === 'reset') { const t = parseReset(value, now); if (t) s.resetAt = t; }
    else { const n = Number(value); if (Number.isFinite(n)) s[field] = n; }
  }
  const windows = [...map.values()].filter((w) => Number.isFinite(w.limit) && w.limit > 0 && Number.isFinite(w.remaining));
  return windows.length ? { windows, at: now } : null;
}

// "2026-11-04T12:00:00Z", "1m30.5s", "20ms", "6h0m0s", "12" (seconds) or an epoch timestamp.
function parseReset(v, now) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return now + n * 1000;
  }
  if (/\d{4}-\d{2}-\d{2}/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  let ms = 0, matched = false;
  for (const [, num, unit] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    ms += Number(num) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  }
  return matched ? now + ms : null;
}

const QUOTA_RE = /credit balance|insufficient|quota|billing|exceeded your current|balance|payment required|out of credits|spend limit|usage limit|RESOURCE_EXHAUSTED/i;
const RATE_RE = /rate.?limit|too many requests|requests per|tokens per|try again in|RESOURCE_EXHAUSTED/i;

// 'quota' (credits/plan used up), 'rate' (temporary rate limit), 'overloaded' (provider busy) or null.
export function classifyLimit(status, message = '') {
  const msg = String(message);
  if (status === 402) return 'quota';
  if (status === 429) return QUOTA_RE.test(msg) && !/rate.?limit/i.test(msg) ? 'quota' : 'rate';
  if (status === 529 || /overloaded/i.test(msg)) return 'overloaded';
  if ((status === 400 || status === 403) && QUOTA_RE.test(msg)) return 'quota';
  if (!status && RATE_RE.test(msg)) return 'rate';
  return null;
}

export function retryAfterMs(headers) {
  const v = headers?.get?.('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}
