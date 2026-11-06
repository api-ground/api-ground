import { app, persist } from './state.js';
import { h } from './ui.js';

export function headers(provider) {
  const h = { 'Content-Type': 'application/json' };
  const key = app.settings.keys[provider];
  if (key) h['X-API-Key'] = key;
  const base = app.settings.bases?.[provider];
  if (base) h['X-Base-URL'] = base;
  if (app.settings.password) h['X-Access-Password'] = app.settings.password;
  return h;
}

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // limit: 'quota' | 'rate' | 'overloaded' when the provider's usage limit was hit (see src/limits.js)
    throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { status: res.status, limit: data.limit || null, retryAfter: data.retryAfter ?? null, limits: data.limits || null });
  }
  return data;
}

export async function getJSON(path, provider) {
  return parse(await fetch(path, { headers: headers(provider) }));
}

export async function postJSON(path, provider, body, signal) {
  return parse(await fetch(path, { method: 'POST', headers: headers(provider), body: JSON.stringify(body), signal }));
}

export async function* streamChat(body, signal) {
  const res = await fetch('/api/chat', { method: 'POST', headers: headers(body.provider), body: JSON.stringify(body), signal });
  if (!res.ok) await parse(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!line.startsWith('data:')) continue;
      try { yield JSON.parse(line.slice(5)); } catch {}
    }
  }
}

export async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error();
    app.config = await res.json();
  } catch {
    app.config = { providers: [{ id: 'gemini', name: 'Gemini', company: 'Google', type: 'gemini', icon: 'gemini', models: ['gemini-2.5-flash'] }], passwordRequired: false };
  }
  if (!app.config.providers.some((p) => p.id === app.settings.provider)) app.settings.provider = 'gemini';
}

export function providerInfo(id) {
  return app.config.providers.find((p) => p.id === id) || { id, name: id, type: 'openai', models: [] };
}

export const isGemini = (id = app.settings.provider) => providerInfo(id).type === 'gemini';

export function hasKey(id) {
  return Boolean(app.settings.keys[id]) || Boolean(providerInfo(id).serverKey);
}

export function anyKey() {
  return app.config.providers.some((p) => hasKey(p.id));
}

function fallback(provider) {
  return { chat: (providerInfo(provider).models || []).map((id) => ({ id, name: id })), embed: [], fallback: true };
}

export async function loadModels(provider, force = false) {
  if (app.models[provider] && !force) return app.models[provider];
  if (!hasKey(provider) && !providerInfo(provider).publicModels) return (app.models[provider] = fallback(provider));
  try {
    app.models[provider] = await getJSON('/api/models?provider=' + provider, provider);
    if (!app.models[provider].chat?.length) app.models[provider] = fallback(provider);
  } catch (e) {
    app.models[provider] = { ...fallback(provider), error: e.message };
  }
  return app.models[provider];
}

export function currentModel(provider = app.settings.provider) {
  const preferred = providerInfo(provider).models?.[0];
  const list = app.models[provider]?.chat || fallback(provider).chat;
  let m = app.settings.model[provider];
  if (!list.some((x) => x.id === m)) {
    m = (list.find((x) => x.id === preferred) || list[0] || {}).id;
    if (m) { app.settings.model[provider] = m; persist('settings'); }
  }
  return m || preferred || '';
}

export function modelLabel(id) {
  const m = Object.values(app.models).flatMap((x) => x.chat || []).find((x) => x.id === id);
  return m && m.name && m.name !== id ? m.name : id;
}

// Collects a full (non-streamed) completion from the streaming endpoint.
export async function complete(body, signal) {
  let text = '';
  for await (const ev of streamChat(body, signal)) {
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'error') throw new Error(ev.message);
  }
  return text;
}

// ---------- brand icons ----------
const BRAND_RULES = [
  [/claude|anthropic/i, 'claude'], [/\bgpt|chatgpt|openai\/|^o[1345](-|$)/i, 'openai'], [/gemini/i, 'gemini'], [/gemma/i, 'gemma'],
  [/grok/i, 'grok'], [/kimi|moonshot/i, 'kimi'], [/glm|zhipu|z-ai|zai-org/i, 'zhipu'], [/deepseek/i, 'deepseek'], [/qwen|qwq/i, 'qwen'],
  [/mistral|mixtral|codestral|ministral|magistral|devstral|pixtral/i, 'mistral'], [/llama|meta[/-]/i, 'meta'], [/nemotron|nvidia|^nv-/i, 'nvidia'],
  [/\bphi-|microsoft/i, 'microsoft'], [/minimax/i, 'minimax'], [/command|cohere|\baya/i, 'cohere'], [/sonar|perplexity/i, 'perplexity'],
  [/granite|ibm\//i, 'ibm'], [/step-|stepfun/i, 'stepfun'], [/jamba|ai21/i, 'ai21'], [/\byi-|01-ai/i, 'yi'], [/arctic|snowflake/i, 'snowflake'],
];
const MONO = new Set(['openai', 'anthropic', 'grok', 'xai', 'moonshot', 'zai', 'groq', 'ibm', 'ai21']);

export function modelBrand(modelId, provider) {
  for (const [re, brand] of BRAND_RULES) if (re.test(modelId || '')) return brand;
  return providerInfo(provider).icon || 'openai';
}

export function brandImg(name, size = 18) {
  return h('img', { class: 'brand-ico' + (MONO.has(name) ? ' mono' : ''), src: 'img/brands/' + name + '.svg', width: size, height: size, alt: '', loading: 'lazy' });
}

export function brandHTML(name, size = 16) {
  return '<img class="brand-ico' + (MONO.has(name) ? ' mono' : '') + '" src="img/brands/' + name + '.svg" width="' + size + '" height="' + size + '" alt="">';
}
