import Anthropic from '@anthropic-ai/sdk';
import { parseLimits } from './limits.js';

// Models that support the server-side refusal fallback ("default" routing picks the fallback model by category).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// web_search_20260209 (dynamic filtering) is limited to these families; others use the basic variant.
const NEW_SEARCH = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6))/;
// Adaptive thinking is accepted on the 4.6+ generation; older models (e.g. Haiku 4.5) would reject it.
const ADAPTIVE = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable|mythos|haiku-5)/;
const IMAGE = /^image\/(jpeg|png|gif|webp)$/;

// Pin credentials and endpoint so ambient ANTHROPIC_* environment variables on the host can't override the user's key.
const client = (key) => new Anthropic({ apiKey: key, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 1 });

export function anthropicError(e) {
  if (e instanceof Anthropic.APIError) {
    return { status: e.status || 502, message: e.error?.error?.message || e.message, headers: e.headers };
  }
  return null;
}

function toMessages(messages) {
  return messages.map((m) => {
    const content = [];
    if (m.role === 'user') {
      for (const f of m.files || []) {
        if (IMAGE.test(f.mimeType)) content.push({ type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.data } });
        else if (f.mimeType === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
      }
    }
    content.push({ type: 'text', text: m.text && m.text.trim() ? m.text : '…' });
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
  });
}

function startStream(c, model, params) {
  return FALLBACK_MODELS.has(model)
    ? c.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
    : c.messages.stream(params);
}

export async function* anthropicChat(key, model, body) {
  const c = client(key);
  const p = body.params || {};
  const tools = body.tools || {};
  const base = { model, max_tokens: p.maxTokens || 32000 };
  if (body.systemPrompt) base.system = body.systemPrompt;
  if (tools.thinking && ADAPTIVE.test(model)) base.thinking = { type: 'adaptive', display: 'summarized' };
  if (tools.search) base.tools = [{ type: NEW_SEARCH.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search' }];

  let messages = toMessages(body.messages || []);
  let input = 0, output = 0;
  // pause_turn: the server paused a long server-tool turn; resend with the partial assistant turn to continue.
  for (let round = 0; round < 5; round++) {
    const stream = startStream(c, model, { ...base, messages });
    let roundOut = 0;
    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        const u = ev.message.usage || {};
        input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } else if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          yield { type: 'sources', sources: b.content.filter((r) => r.url).map((r) => ({ title: r.title, uri: r.url })) };
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d.type === 'text_delta') yield { type: 'text', text: d.text };
        else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'thought', text: d.thinking };
        else if (d.type === 'citations_delta' && d.citation?.url) yield { type: 'sources', sources: [{ title: d.citation.title, uri: d.citation.url }] };
      } else if (ev.type === 'message_delta') {
        roundOut = ev.usage?.output_tokens || roundOut;
      }
    }
    const msg = await stream.finalMessage();
    output += roundOut;
    yield { type: 'usage', input, output, total: input + output };
    const limits = parseLimits(stream.response?.headers);
    if (limits) yield { type: 'limits', ...limits };
    if (msg.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: msg.content }]; continue; }
    if (msg.stop_reason === 'max_tokens') yield { type: 'finish', reason: 'MAX_TOKENS' };
    if (msg.stop_reason === 'refusal') {
      yield { type: 'error', message: 'Claude declined this request' + (msg.stop_details?.explanation ? ': ' + msg.stop_details.explanation : '.') };
    }
    break;
  }
}

export async function anthropicModels(key) {
  const out = [];
  for await (const m of client(key).models.list({ limit: 100 })) {
    out.push({ id: m.id, name: m.display_name || m.id, inputLimit: m.max_input_tokens, outputLimit: m.max_tokens });
  }
  return out;
}

// One Code-mode agent step. history is the provider-native Anthropic messages array kept by the client.
export async function anthropicAgent(key, model, body) {
  const c = client(key);
  const params = {
    model,
    max_tokens: 32000,
    messages: body.history,
    tools: (body.tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };
  if (body.system) params.system = body.system;
  if (body.thinking && ADAPTIVE.test(model)) params.thinking = { type: 'adaptive', display: 'summarized' };
  const stream = startStream(c, model, params);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw Object.assign(new Error('Claude declined this request' + (msg.stop_details?.explanation ? ': ' + msg.stop_details.explanation : '.')), { status: 422 });
  }
  const u = msg.usage || {};
  return {
    // Content is passed back unchanged on the next request (thinking blocks must not be edited).
    native: { role: 'assistant', content: msg.content },
    text: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    thoughts: msg.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join(''),
    toolCalls: msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    finishReason: msg.stop_reason,
    usage: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 },
    limits: parseLimits(stream.response?.headers),
  };
}
