// type: 'gemini' (native Gemini API), 'anthropic' (Claude Messages API via SDK), 'openai' (OpenAI-compatible /chat/completions)
// models: shown before a key is entered or when the provider has no model-list endpoint (checked against provider docs 2026-11).
export const PROVIDERS = {
  anthropic: { name: 'Claude', company: 'Anthropic', type: 'anthropic', envKey: 'ANTHROPIC_API_KEY', icon: 'claude', keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  openai: { name: 'OpenAI', company: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', icon: 'openai', maxTokensParam: 'max_completion_tokens', streamUsage: true, keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'] },
  gemini: { name: 'Gemini', company: 'Google', type: 'gemini', envKey: 'GEMINI_API_KEY', icon: 'gemini', keyUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image'] },
  xai: { name: 'Grok', company: 'xAI', type: 'openai', base: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', icon: 'grok', keyUrl: 'https://console.x.ai',
    models: ['grok-4.7', 'grok-4.6', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'] },
  deepseek: { name: 'DeepSeek', company: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', icon: 'deepseek', streamUsage: true, keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-v4-pro', 'deepseek-flash'] },
  moonshot: { name: 'Kimi', company: 'Moonshot AI', type: 'openai', base: 'https://api.moonshot.ai/v1', envKey: 'MOONSHOT_API_KEY', icon: 'kimi', maxTokensParam: 'max_completion_tokens', streamUsage: true, keepReasoning: true, keyUrl: 'https://platform.kimi.ai',
    models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'] },
  zai: { name: 'GLM', company: 'Z.ai (Zhipu)', type: 'openai', base: 'https://api.z.ai/api/paas/v4', envKey: 'ZAI_API_KEY', icon: 'zhipu', keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.3-flash'] },
  qwen: { name: 'Qwen', company: 'Alibaba Cloud', type: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', icon: 'qwen', customBase: /^https:\/\/[\w.-]+\.aliyuncs\.com\/compatible-mode\/v1$/, keyUrl: 'https://modelstudio.console.alibabacloud.com',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen-plus'] },
  mistral: { name: 'Mistral', company: 'Mistral AI', type: 'openai', base: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', icon: 'mistral', keyUrl: 'https://console.mistral.ai/api-keys',
    models: ['mistral-large-4', 'mistral-medium-3-5', 'mistral-small-2603', 'ministral-14b-2512'] },
  minimax: { name: 'MiniMax', company: 'MiniMax', type: 'openai', base: 'https://api.minimax.io/v1', envKey: 'MINIMAX_API_KEY', icon: 'minimax', maxTokensParam: 'max_completion_tokens', noModelList: true, keyUrl: 'https://www.minimax.io/platform',
    models: ['MiniMax-M3', 'MiniMax-M3.1-Flash'] },
  nvidia: { name: 'NVIDIA NIM', company: 'NVIDIA · 무료 체험', type: 'openai', base: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_API_KEY', icon: 'nvidia', publicModels: true, keyUrl: 'https://build.nvidia.com',
    models: ['nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k2.6', 'z-ai/glm-5.3-flash', 'openai/gpt-oss-20b'] },
  groq: { name: 'Groq', company: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', icon: 'groq', keyUrl: 'https://console.groq.com/keys',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  openrouter: { name: 'OpenRouter', company: 'OpenRouter', type: 'openai', base: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', icon: 'openrouter', publicModels: true, streamUsage: true, keyUrl: 'https://openrouter.ai/keys',
    models: ['openrouter/auto'] },
  together: { name: 'Together AI', company: 'Together AI', type: 'openai', base: 'https://api.together.ai/v1', envKey: 'TOGETHER_API_KEY', icon: 'together', keyUrl: 'https://api.together.ai/settings/api-keys',
    models: ['moonshotai/Kimi-K3', 'zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4-Pro-0813', 'Qwen/Qwen3.7-Max'] },
  fireworks: { name: 'Fireworks AI', company: 'Fireworks AI', type: 'openai', base: 'https://api.fireworks.ai/inference/v1', envKey: 'FIREWORKS_API_KEY', icon: 'fireworks', keyUrl: 'https://fireworks.ai/account/api-keys',
    models: ['accounts/fireworks/models/glm-5p3', 'accounts/fireworks/models/minimax-m3p1-flash'] },
  cerebras: { name: 'Cerebras', company: 'Cerebras', type: 'openai', base: 'https://api.cerebras.ai/v1', envKey: 'CEREBRAS_API_KEY', icon: 'cerebras', keyUrl: 'https://cloud.cerebras.ai',
    models: ['gpt-oss-120b', 'qwen-3.8-27b'] },
  sambanova: { name: 'SambaNova', company: 'SambaNova', type: 'openai', base: 'https://api.sambanova.ai/v1', envKey: 'SAMBANOVA_API_KEY', icon: 'sambanova', keyUrl: 'https://cloud.sambanova.ai/apis',
    models: ['gpt-oss-120b', 'DeepSeek-V3.1', 'Meta-Llama-3.3-70B-Instruct'] },
  huggingface: { name: 'Hugging Face', company: 'Inference Providers', type: 'openai', base: 'https://router.huggingface.co/v1', envKey: 'HF_TOKEN', icon: 'huggingface', keyUrl: 'https://huggingface.co/settings/tokens',
    models: ['openai/gpt-oss-120b', 'deepseek-ai/DeepSeek-R1'] },
  cohere: { name: 'Cohere', company: 'Cohere', type: 'openai', base: 'https://api.cohere.ai/compatibility/v1', envKey: 'COHERE_API_KEY', icon: 'cohere', noModelList: true, keyUrl: 'https://dashboard.cohere.com/api-keys',
    models: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-vision-07-2025', 'command-r7b-12-2024'] },
  perplexity: { name: 'Perplexity', company: 'Perplexity', type: 'openai', base: 'https://api.perplexity.ai', envKey: 'PERPLEXITY_API_KEY', icon: 'perplexity', noModelList: true, keyUrl: 'https://www.perplexity.ai/account/api/keys',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'] },
};

// Model IDs that are not chat models (embeddings, speech, image, safety classifiers...).
export const NON_CHAT = /(embed|whisper|tts|speech|transcri|dall-e|gpt-image|imagen|image-gen|flux|stable-diffusion|sdxl|audio|moderation|guard|safety|reward|rerank|nvclip|parse|retriever|detector|deplot|calibration|realtime|sora|veo|ocr)/i;

export function baseFor(provider, request) {
  const override = request.headers.get('X-Base-URL');
  if (override && provider.customBase?.test(override)) return override;
  return provider.base;
}
