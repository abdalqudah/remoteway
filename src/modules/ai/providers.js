// Provider adapters. Each turns one request {system, prompt, files, maxTokens} into the provider's own
// HTTP API and returns {text, tokensIn, tokensOut}. Calls go through the SSRF-safe HTTP client.
// AI_PROVIDER_BASE_URL (tests only) points every adapter at a local stand-in server.
const { request } = require('../../core/http');

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', base: 'https://api.anthropic.com', models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'], pdf: true, images: true },
  openai: { label: 'OpenAI', base: 'https://api.openai.com', models: [], pdf: true, images: true },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com', models: [], pdf: true, images: true },
  azure: { label: 'Azure OpenAI', base: null, models: [], pdf: false, images: true },
};
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const base = (cfg, fallback) => (process.env.AI_PROVIDER_BASE_URL || fallback).replace(/\/+$/, '');

function explain(status, body) {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error.status)) || j.message || '';
  } catch { detail = ''; }
  detail = String(detail).slice(0, 200);
  if (status === 401 || status === 403) return `The AI provider rejected the API key (${status}).`;
  if (status === 404) return `The model or endpoint was not found (${status}). ${detail}`.trim();
  if (status === 429) return 'The AI provider is rate limiting this account or its quota is used up (429).';
  if (status >= 500) return `The AI provider is temporarily unavailable (${status}).`;
  return `The AI provider returned an error (${status}). ${detail}`.trim();
}

async function post(url, headers, payload, timeoutMs) {
  const res = await request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload), timeoutMs, maxBytes: 4 * 1024 * 1024,
  });
  if (res.status < 200 || res.status >= 300) throw new ProviderError(explain(res.status, res.body), res.status);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ProviderError('The AI provider sent a response that could not be read.');
  }
}

const b64 = (f) => f.data.toString('base64');

const adapters = {
  async anthropic(cfg, { system, prompt, files, maxTokens, timeoutMs }) {
    const content = [];
    for (const f of files) {
      if (f.mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(f) } });
      else content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: b64(f) } });
    }
    content.push({ type: 'text', text: prompt });
    const j = await post(`${base(cfg, PROVIDERS.anthropic.base)}/v1/messages`, { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      { model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }, timeoutMs);
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text, tokensIn: j.usage?.input_tokens || 0, tokensOut: j.usage?.output_tokens || 0 };
  },

  async openai(cfg, req) {
    return openAiCompatible(`${base(cfg, PROVIDERS.openai.base)}/v1/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, { model: cfg.model }, req);
  },

  async azure(cfg, req) {
    const endpoint = base(cfg, cfg.endpoint || '');
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment || cfg.model)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion || '2024-10-21')}`;
    return openAiCompatible(url, { 'api-key': cfg.apiKey }, {}, req);
  },

  async gemini(cfg, { system, prompt, files, maxTokens, timeoutMs, json }) {
    const parts = files.map((f) => ({ inline_data: { mime_type: f.mime, data: b64(f) } }));
    parts.push({ text: prompt });
    const j = await post(`${base(cfg, PROVIDERS.gemini.base)}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, { 'x-goog-api-key': cfg.apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }, timeoutMs);
    const cand = (j.candidates || [])[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
    return { text, tokensIn: j.usageMetadata?.promptTokenCount || 0, tokensOut: j.usageMetadata?.candidatesTokenCount || 0 };
  },
};

async function openAiCompatible(url, headers, extra, { system, prompt, files, maxTokens, timeoutMs, json }) {
  const content = [];
  for (const f of files) {
    if (f.mime === 'application/pdf') content.push({ type: 'file', file: { filename: f.name || 'document.pdf', file_data: `data:application/pdf;base64,${b64(f)}` } });
    else content.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${b64(f)}` } });
  }
  content.push({ type: 'text', text: prompt });
  const j = await post(url, headers, {
    ...extra,
    max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  }, timeoutMs);
  const text = j.choices?.[0]?.message?.content || '';
  return { text: typeof text === 'string' ? text : '', tokensIn: j.usage?.prompt_tokens || 0, tokensOut: j.usage?.completion_tokens || 0 };
}

/** Which attached file types the configured provider can read. */
function accepts(provider, mime) {
  const p = PROVIDERS[provider];
  if (!p) return false;
  if (mime === 'application/pdf') return p.pdf;
  return p.images && IMAGE_MIME.includes(mime);
}

async function complete(cfg, req) {
  const adapter = adapters[cfg.provider];
  if (!adapter) throw new ProviderError('Unknown AI provider.');
  return adapter(cfg, { files: [], maxTokens: 1500, timeoutMs: 90_000, json: true, ...req });
}

module.exports = { PROVIDERS, IMAGE_MIME, ProviderError, complete, accepts };
