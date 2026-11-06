import { PROVIDERS, NON_CHAT, baseFor } from './providers.js';
import { anthropicChat, anthropicModels, anthropicAgent, anthropicError } from './anthropic.js';
import { handleAuth, sharePage, downloadFile, AuthError, PRIVATE_FILES } from './auth.js';
import { parseLimits, classifyLimit, retryAfterMs } from './limits.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_ID_RE = /^[A-Za-z0-9._:\/@-]{1,200}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Access-Password, X-Base-URL, X-Client',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function withCors(res) {
  if (res.status === 101 || res.headers.get('Location')?.startsWith('http')) return res;
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

// Secrets pasted through some shells arrive with a leading BOM or trailing newline; strip them.
function cleanEnv(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(out)) if (typeof v === 'string') out[k] = v.replace(/^﻿/, '').trim();
  return out;
}

export default {
  async fetch(request, env, ctx) {
    env = cleanEnv(env);
    const url = new URL(request.url);
    const path = url.pathname;

    const share = path.match(/^\/share\/([\w-]{6,32})$/);
    if (share) return sharePage(env, share[1]);
    if (path === '/download/file') return downloadFile(env, url);
    if (path === '/download') return Response.redirect(url.origin + '/?login=download#download', 302);
    if (path.toLowerCase().startsWith(PRIVATE_FILES)) return new Response('Not found', { status: 404 });
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      return withCors(await route(request, env, url, path, ctx));
    } catch (e) {
      const status = e.status || anthropicError(e)?.status || 500;
      const message = anthropicError(e)?.message || (e instanceof HttpError || e instanceof AuthError ? e.message : '서버 오류: ' + e.message);
      return withCors(Response.json({ error: message, ...limitInfo(status, message, anthropicError(e)?.headers) }, { status }));
    }
  },
};

async function route(request, env, url, path, ctx) {
  if (path === '/api/config') return handleConfig(env);
  if (path.startsWith('/api/auth/') || path.startsWith('/api/me') || path === '/api/sync' || path.startsWith('/api/share')
    || path === '/api/download') {
    return handleAuth(request, env, url, ctx);
  }
  if (env.ACCESS_PASSWORD && request.headers.get('X-Access-Password') !== env.ACCESS_PASSWORD) {
    throw new HttpError('접근 비밀번호가 올바르지 않습니다.', 401);
  }
  if (path === '/api/models' && request.method === 'GET') return handleModels(request, env, url);
  if (request.method !== 'POST') throw new HttpError('Not Found', 404);
  const body = await request.json().catch(() => null);
  if (!body) throw new HttpError('잘못된 요청 형식입니다.', 400);
  switch (path) {
    case '/api/chat': return handleChat(request, env, body);
    case '/api/agent': return handleAgent(request, env, body);
    case '/api/embed': return handleEmbed(request, env, body);
    case '/api/tokens': return handleTokens(request, env, body);
  }
  throw new HttpError('Not Found', 404);
}

function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new HttpError('지원하지 않는 공급자입니다: ' + id, 400);
  return p;
}

function getKey(request, env, provider) {
  const key = request.headers.get('X-API-Key') || env[provider.envKey];
  if (!key) throw new HttpError(provider.name + ' API 키가 필요합니다. 설정에서 입력하세요.', 401);
  return key;
}

function checkModel(model) {
  const id = String(model || '').replace(/^models\//, '');
  if (!MODEL_ID_RE.test(id) || id.includes('..')) throw new HttpError('잘못된 모델 ID입니다.', 400);
  return id;
}

async function upstreamError(res) {
  const text = await res.text();
  let message = text;
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    message = (typeof e === 'string' ? e : e?.message) || j.message || text;
  } catch {}
  return Response.json({ error: message || ('Upstream error ' + res.status), ...limitInfo(res.status, message, res.headers) }, { status: res.status });
}

// Extra error fields when a provider limit was hit: limit kind, retry delay and the latest rate-limit windows.
function limitInfo(status, message, headers) {
  const limit = classifyLimit(status, message);
  if (!limit) return {};
  return { limit, retryAfter: retryAfterMs(headers), limits: parseLimits(headers) };
}

function handleConfig(env) {
  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, company: p.company, type: p.type, icon: p.icon, keyUrl: p.keyUrl,
    serverKey: Boolean(env[p.envKey]), publicModels: Boolean(p.publicModels), customBase: Boolean(p.customBase),
    keepReasoning: Boolean(p.keepReasoning),
    models: p.models || [],
  }));
  return Response.json({ providers, passwordRequired: Boolean(env.ACCESS_PASSWORD), auth: Boolean(env.DB), appName: env.APP_NAME || 'API-Ground' });
}

async function handleModels(request, env, url) {
  const provider = getProvider(url.searchParams.get('provider') || 'gemini');
  const key = request.headers.get('X-API-Key') || env[provider.envKey];
  const fallback = () => Response.json({ chat: (provider.models || []).map((id) => ({ id, name: id })), embed: [], fallback: true });
  if (!key && !provider.publicModels) throw new HttpError(provider.name + ' API 키가 필요합니다.', 401);

  if (provider.type === 'anthropic') return Response.json({ chat: await anthropicModels(key), embed: [] });

  if (provider.type === 'gemini') {
    const res = await fetch(GEMINI_BASE + '/models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) return upstreamError(res);
    const data = await res.json();
    const models = (data.models || []).map((m) => ({
      id: m.name.replace(/^models\//, ''), name: m.displayName || m.name,
      methods: m.supportedGenerationMethods || [], inputLimit: m.inputTokenLimit, outputLimit: m.outputTokenLimit,
    }));
    return Response.json({
      chat: models.filter((m) => m.methods.includes('generateContent')),
      embed: models.filter((m) => m.methods.includes('embedContent')),
    });
  }

  if (provider.noModelList) return fallback();
  const res = await fetch(baseFor(provider, request) + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
  if (!res.ok) {
    if (res.status === 404) return fallback();
    return upstreamError(res);
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.data || data.models || [];
  const chat = list
    .map((m) => ({ id: m.id || m.name, name: m.display_name || m.name || m.id, inputLimit: m.context_length || m.context_window }))
    .filter((m) => m.id && !NON_CHAT.test(m.id) && (!m.type || m.type === 'chat' || m.type === 'language'))
    .sort((a, b) => a.id.localeCompare(b.id));
  return chat.length ? Response.json({ chat, embed: [] }) : fallback();
}

// ---------- chat ----------
function toGeminiContents(messages) {
  return messages.map((m) => {
    const parts = [];
    for (const f of m.files || []) parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
    if (m.text) parts.push({ text: m.text });
    if (!parts.length) parts.push({ text: ' ' });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

function toOpenAIMessages(messages, systemPrompt) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    const images = (m.files || []).filter((f) => f.mimeType.startsWith('image/'));
    if (m.role === 'user' && images.length) {
      out.push({
        role: 'user',
        content: [
          ...images.map((f) => ({ type: 'image_url', image_url: { url: 'data:' + f.mimeType + ';base64,' + f.data } })),
          { type: 'text', text: m.text || '' },
        ],
      });
    } else {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text || '' });
    }
  }
  return out;
}

async function handleChat(request, env, body) {
  const provider = getProvider(body.provider || 'gemini');
  const key = getKey(request, env, provider);
  const model = checkModel(body.model);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const p = body.params || {};
  const tools = body.tools || {};

  if (provider.type === 'anthropic') {
    const it = anthropicChat(key, model, body)[Symbol.asyncIterator]();
    const first = await it.next(); // surfaces auth/model errors as an HTTP error instead of a mid-stream event
    return sseFromIterator(first, it);
  }

  if (provider.type === 'gemini') {
    const generationConfig = {};
    if (p.temperature != null) generationConfig.temperature = p.temperature;
    if (p.topP != null) generationConfig.topP = p.topP;
    if (p.maxTokens != null) generationConfig.maxOutputTokens = p.maxTokens;
    if (/image/i.test(model)) generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    if (tools.thinking) generationConfig.thinkingConfig = { includeThoughts: true };
    const geminiTools = [];
    if (tools.search) geminiTools.push({ googleSearch: {} });
    if (tools.urlContext) geminiTools.push({ urlContext: {} });
    if (tools.codeExecution) geminiTools.push({ codeExecution: {} });
    const payload = { contents: toGeminiContents(messages), generationConfig };
    if (body.systemPrompt) payload.systemInstruction = { parts: [{ text: body.systemPrompt }] };
    if (geminiTools.length) payload.tools = geminiTools;
    const res = await fetch(GEMINI_BASE + '/models/' + model + ':streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return upstreamError(res);
    return sseResponse(res, parseGeminiChunk, parseLimits(res.headers));
  }

  const payload = { model, stream: true, messages: toOpenAIMessages(messages, body.systemPrompt) };
  if (provider.streamUsage) payload.stream_options = { include_usage: true };
  if (p.temperature != null) payload.temperature = p.temperature;
  if (p.topP != null) payload.top_p = p.topP;
  if (p.maxTokens != null) payload[provider.maxTokensParam || 'max_tokens'] = p.maxTokens;
  const res = await fetch(baseFor(provider, request) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return upstreamError(res);
  return sseResponse(res, parseOpenAIChunk, parseLimits(res.headers));
}

function parseGeminiChunk(j) {
  const out = [];
  if (j.error) out.push({ type: 'error', message: j.error.message, limit: classifyLimit(j.error.code, (j.error.status || '') + ' ' + (j.error.message || '')) });
  const c = j.candidates?.[0];
  for (const part of c?.content?.parts || []) {
    if (part.text) out.push({ type: part.thought ? 'thought' : 'text', text: part.text });
    if (part.inlineData) out.push({ type: 'image', mimeType: part.inlineData.mimeType, data: part.inlineData.data });
    if (part.executableCode) out.push({ type: 'code', language: part.executableCode.language, code: part.executableCode.code });
    if (part.codeExecutionResult) out.push({ type: 'codeResult', outcome: part.codeExecutionResult.outcome, output: part.codeExecutionResult.output });
  }
  const chunks = c?.groundingMetadata?.groundingChunks;
  if (chunks?.length) out.push({ type: 'sources', sources: chunks.filter((x) => x.web).map((x) => ({ title: x.web.title, uri: x.web.uri })) });
  if (c?.finishReason && c.finishReason !== 'STOP') out.push({ type: 'finish', reason: c.finishReason });
  if (j.promptFeedback?.blockReason) out.push({ type: 'error', message: '차단됨: ' + j.promptFeedback.blockReason });
  const u = j.usageMetadata;
  if (u) out.push({ type: 'usage', input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), total: u.totalTokenCount || 0 });
  return out;
}

function parseOpenAIChunk(j) {
  const out = [];
  if (j.error) out.push({ type: 'error', message: j.error.message || String(j.error), limit: classifyLimit(Number(j.error.code) || 0, j.error.message || String(j.error)) });
  const d = j.choices?.[0]?.delta;
  const reasoning = d?.reasoning_content || d?.reasoning;
  if (reasoning) out.push({ type: 'thought', text: reasoning });
  if (d?.content) out.push({ type: 'text', text: d.content });
  if (Array.isArray(j.citations) && j.citations.length) out.push({ type: 'sources', sources: j.citations.map((u) => ({ title: u, uri: u })) });
  const reason = j.choices?.[0]?.finish_reason;
  if (reason && reason !== 'stop' && reason !== 'tool_calls') out.push({ type: 'finish', reason });
  if (j.usage) out.push({ type: 'usage', input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0, total: j.usage.total_tokens || 0 });
  return out;
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' };

function sseResponse(upstream, parse, limits) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
      if (limits) send({ type: 'limits', ...limits });
      const reader = upstream.body.getReader();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let json;
            try { json = JSON.parse(data); } catch { continue; }
            for (const ev of parse(json)) send(ev);
          }
        }
      } catch (e) {
        send({ type: 'error', message: e.message });
      }
      send({ type: 'done' });
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function sseFromIterator(first, it) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
      try {
        let r = first;
        while (!r.done) { send(r.value); r = await it.next(); }
      } catch (e) {
        const status = anthropicError(e)?.status;
        const message = anthropicError(e)?.message || e.message;
        send({ type: 'error', message, ...limitInfo(status, message, anthropicError(e)?.headers) });
      }
      send({ type: 'done' });
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

// ---------- Code-mode agent step ----------
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
    else if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else out[k] = toGeminiSchema(v);
  }
  return out;
}

async function handleAgent(request, env, body) {
  const provider = getProvider(body.provider || 'gemini');
  const key = getKey(request, env, provider);
  const model = checkModel(body.model);
  const history = Array.isArray(body.history) ? body.history : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (provider.type === 'anthropic') return Response.json(await anthropicAgent(key, model, { ...body, history }));

  if (provider.type === 'gemini') {
    const payload = { contents: history, generationConfig: {} };
    if (body.system) payload.systemInstruction = { parts: [{ text: body.system }] };
    if (tools.length) payload.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
    if (body.thinking) payload.generationConfig.thinkingConfig = { includeThoughts: true };
    const res = await fetch(GEMINI_BASE + '/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return upstreamError(res);
    const data = await res.json();
    const cand = data.candidates?.[0];
    if (!cand?.content?.parts?.length) {
      throw new HttpError('모델이 빈 응답을 반환했습니다: ' + (data.promptFeedback?.blockReason || cand?.finishReason || 'EMPTY'), 502);
    }
    const parts = cand.content.parts;
    const u = data.usageMetadata || {};
    return Response.json({
      native: { role: 'model', parts },
      text: parts.filter((x) => x.text && !x.thought).map((x) => x.text).join(''),
      thoughts: parts.filter((x) => x.text && x.thought).map((x) => x.text).join(''),
      toolCalls: parts.filter((x) => x.functionCall).map((x, i) => ({ id: x.functionCall.id || ('call_' + i), name: x.functionCall.name, args: x.functionCall.args || {} })),
      finishReason: cand.finishReason,
      usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
      limits: parseLimits(res.headers),
    });
  }

  const payload = { model, messages: [...(body.system ? [{ role: 'system', content: body.system }] : []), ...history] };
  if (tools.length) payload.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const res = await fetch(baseFor(provider, request) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const limits = parseLimits(res.headers);
  const choice = data.choices?.[0] || {};
  const msg = choice.message || { role: 'assistant', content: '' };
  const native = { role: 'assistant', content: msg.content ?? null };
  if (msg.tool_calls?.length) native.tool_calls = msg.tool_calls;
  // Some providers (e.g. Kimi) require earlier reasoning to be sent back unchanged.
  if (provider.keepReasoning && msg.reasoning_content) native.reasoning_content = msg.reasoning_content;
  return Response.json({
    native,
    text: msg.content || '',
    thoughts: msg.reasoning_content || msg.reasoning || '',
    toolCalls: (msg.tool_calls || []).map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      return { id: tc.id, name: tc.function?.name, args };
    }),
    finishReason: choice.finish_reason,
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
    limits,
  });
}

// ---------- Gemini extras ----------
async function handleEmbed(request, env, body) {
  const provider = getProvider('gemini');
  const key = getKey(request, env, provider);
  const model = checkModel(body.model || 'gemini-embedding-001');
  const texts = (Array.isArray(body.texts) ? body.texts : [body.text]).filter(Boolean).slice(0, 100);
  if (!texts.length) throw new HttpError('텍스트를 입력하세요.', 400);
  const res = await fetch(GEMINI_BASE + '/models/' + model + ':batchEmbedContents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      requests: texts.map((t) => {
        const r = { model: 'models/' + model, content: { parts: [{ text: t }] } };
        if (body.taskType) r.taskType = body.taskType;
        if (body.dimensions) r.outputDimensionality = body.dimensions;
        return r;
      }),
    }),
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return Response.json({ embeddings: (data.embeddings || []).map((e) => e.values) });
}

async function handleTokens(request, env, body) {
  const provider = getProvider('gemini');
  const key = getKey(request, env, provider);
  const model = checkModel(body.model);
  const res = await fetch(GEMINI_BASE + '/models/' + model + ':countTokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: toGeminiContents(body.messages || []) }),
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return Response.json({ totalTokens: data.totalTokens || 0 });
}
