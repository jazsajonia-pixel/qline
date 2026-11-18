/**
 * Provider-neutral AI layer (docs/07 §1).
 *
 * Five real providers, each used with the organization's own API key:
 *   openai, anthropic, google (Gemini), xai (Grok), deepseek.
 * OpenAI, Gemini, xAI and DeepSeek speak OpenAI-compatible chat completions;
 * Anthropic uses its native Messages API. Model lists are always fetched live
 * from the provider, never hard-coded.
 *
 * The mock provider exists for tests and is refused outside NODE_ENV=test,
 * so production can never show fake model output.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

/** An image sent with a user message (v1.6). Base64 without the data: prefix. */
export interface ChatImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ChatImage[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallReq[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCallReq {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider-specific data that must be sent back unchanged (e.g. Gemini thought signatures). */
  extra_content?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCallReq }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done' };

export type ProviderErrorCode = 'PROVIDER_NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_AUTH_FAILED';

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public retryable = false,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export interface ChatProvider {
  id: string;
  capabilities: { tools: boolean; streaming: boolean; vision?: boolean };
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

export const PROVIDER_IDS = ['openai', 'anthropic', 'google', 'xai', 'deepseek'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  maker: string;
  keyUrl: string;
  keyPrefix?: string;
  /** Plain-language cost note shown before the owner pastes a key. */
  costNote: string;
  freeTier: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    maker: 'ChatGPT models',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    costNote: 'Pay as you go. Needs billing set up on your OpenAI account.',
    freeTier: false,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    maker: 'Claude models',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    costNote: 'Pay as you go. Needs prepaid credits on your Anthropic account.',
    freeTier: false,
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    maker: 'Gemini models',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
    costNote: 'Free tier available with rate limits. On the free tier Google may use prompts to improve its products.',
    freeTier: true,
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    maker: 'Grok models',
    keyUrl: 'https://console.x.ai',
    keyPrefix: 'xai-',
    costNote: 'Pay as you go. Needs credits on your xAI account.',
    freeTier: false,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    maker: 'DeepSeek models',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPrefix: 'sk-',
    costNote: 'Pay as you go, low prices. Needs a topped-up DeepSeek balance.',
    freeTier: false,
  },
};

const BASE_URLS: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com',
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function httpError(providerName: string, res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const err = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
  const raw = (typeof err === 'string' ? err : err?.message) ?? parsed?.message ?? (text.slice(0, 300) || `HTTP ${res.status}`);
  const msg = `${providerName}: ${String(raw).slice(0, 400)}`;
  if (parsed?.error?.unavailable_reason === 'paid_plan_required' || /not enabled on this account's current plan/i.test(raw)) {
    return new ProviderError('PROVIDER_NOT_CONFIGURED', msg, false, { reason: 'paid_plan_required' });
  }
  if (res.status === 401 || res.status === 403 || /api[_ ]key not valid|valid api key|invalid api key|incorrect api key|invalid x-api-key|api key .*is invalid|authentication[_ ]fails|authentication_error/i.test(raw)) {
    return new ProviderError('PROVIDER_AUTH_FAILED', msg, false, { status: res.status });
  }
  if (res.status === 429) return new ProviderError('PROVIDER_RATE_LIMITED', msg, true, { status: 429 });
  if (res.status === 402) return new ProviderError('PROVIDER_REJECTED', `${msg} (the account needs credits or billing)`, false, { status: 402 });
  if (res.status >= 500) return new ProviderError('PROVIDER_UNAVAILABLE', msg, true, { status: res.status });
  return new ProviderError('PROVIDER_REJECTED', msg, false, { status: res.status });
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        yield { event, data: line.slice(5).trim() };
      } else if (line === '') event = undefined;
    }
  }
  if (buf.trim().startsWith('data:')) yield { event, data: buf.trim().slice(5).trim() };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions (OpenAI, Gemini, xAI, DeepSeek, Neon gateway)
// ---------------------------------------------------------------------------

export interface OpenAICompatOptions {
  id: string;
  name: string;
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** OpenAI's newer models only accept max_completion_tokens. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** Send back assistant reasoning_content on tool-call turns (DeepSeek thinking mode). */
  echoReasoning?: boolean;
  /** Accepts image parts in user messages (default true). */
  vision?: boolean;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatProvider implements ChatProvider {
  id: string;
  capabilities: { tools: boolean; streaming: boolean; vision: boolean };
  constructor(private o: OpenAICompatOptions) {
    this.id = o.id;
    this.capabilities = { tools: true, streaming: true, vision: o.vision !== false };
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const messages = req.messages.map((m) => {
      if (m.role === 'user') {
        // Images go as content parts; providers without vision get the text only.
        if (!m.images?.length || !this.capabilities.vision) return { role: 'user', content: m.content };
        return { role: 'user', content: [{ type: 'text', text: m.content || ' ' }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] };
      }
      if (m.role !== 'assistant') return m;
      const out: Record<string, unknown> = { role: 'assistant', content: m.content ?? '' };
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls.map((tc) => {
          const call: Record<string, unknown> = { id: tc.id, type: 'function', function: tc.function };
          if (tc.extra_content !== undefined) call.extra_content = tc.extra_content;
          return call;
        });
        if (this.o.echoReasoning) out.reasoning_content = m.reasoning_content ?? '';
      }
      return out;
    });
    const body: Record<string, unknown> = { model: req.model, messages, stream: true, stream_options: { include_usage: true } };
    if (req.maxTokens) body[this.o.tokenParam ?? 'max_tokens'] = req.maxTokens;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    return body;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const f = this.o.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.buildBody(req)),
        signal,
      });
    } catch (e) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', `${this.o.name} could not be reached: ${(e as Error).message}`, true);
    }
    if (!res.ok || !res.body) throw await httpError(this.o.name, res);

    const pending = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
    for await (const { data } of sseLines(res.body)) {
      if (!data || data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError('PROVIDER_REJECTED', `${this.o.name}: ${chunk.error.message ?? 'stream error'}`);
      if (chunk.usage) {
        yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
      const content = delta.content;
      if (typeof content === 'string' && content) yield { type: 'token', text: content };
      else if (Array.isArray(content)) {
        for (const part of content) if (part?.type === 'text' && part.text) yield { type: 'token', text: part.text };
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? pending.size;
        const cur = pending.get(i) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        if (tc.extra_content !== undefined) cur.extra = tc.extra_content;
        pending.set(i, cur);
      }
    }
    for (const [i, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCallReq = { id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } };
      if (c.extra !== undefined) call.extra_content = c.extra;
      yield { type: 'tool_call', call };
    }
    yield { type: 'done' };
  }
}

/** Kept for environments that use the Neon AI Gateway (needs paid credits); not offered in the app. */
export class NeonGatewayProvider extends OpenAICompatProvider {
  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    super({ id: 'neon-ai-gateway', name: 'Neon AI Gateway', baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`, apiKey: token, fetchImpl });
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

export class AnthropicProvider implements ChatProvider {
  id = 'anthropic';
  capabilities = { tools: true, streaming: true, vision: true };
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private baseUrl = BASE_URLS.anthropic,
  ) {}

  buildBody(req: ChatRequest): Record<string, unknown> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content as string).join('\n\n');
    const messages: { role: 'user' | 'assistant'; content: any[] }[] = [];
    const push = (role: 'user' | 'assistant', block: any) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(block);
      else messages.push({ role, content: [block] });
    };
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        for (const i of m.images ?? []) push('user', { type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } });
        push('user', { type: 'text', text: m.content || ' ' });
      }
      else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || ' ' });
      else if (m.role === 'assistant') {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        for (const tc of m.tool_calls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          push('assistant', { type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        if (!m.content && !m.tool_calls?.length) push('assistant', { type: 'text', text: ' ' });
      }
    }
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? 2048, messages, stream: true };
    if (system) body.system = system;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    return body;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(this.buildBody(req)),
        signal,
      });
    } catch (e) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', `Anthropic could not be reached: ${(e as Error).message}`, true);
    }
    if (!res.ok || !res.body) throw await httpError('Anthropic', res);
    let inputTokens = 0;
    let outputTokens = 0;
    const blocks = new Map<number, { id: string; name: string; args: string }>();
    for await (const { data } of sseLines(res.body)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          inputTokens = ev.message?.usage?.input_tokens ?? 0;
          outputTokens = ev.message?.usage?.output_tokens ?? 0;
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, args: '' });
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'token', text: ev.delta.text };
          else if (ev.delta?.type === 'input_json_delta') {
            const b = blocks.get(ev.index);
            if (b) b.args += ev.delta.partial_json ?? '';
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) yield { type: 'reasoning', text: ev.delta.thinking };
          break;
        case 'message_delta':
          if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
          if (ev.usage?.input_tokens != null) inputTokens = ev.usage.input_tokens;
          break;
        case 'error':
          throw new ProviderError(ev.error?.type === 'overloaded_error' ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED', `Anthropic: ${ev.error?.message ?? 'stream error'}`, ev.error?.type === 'overloaded_error');
      }
    }
    for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
      yield { type: 'tool_call', call: { id: b.id, type: 'function', function: { name: b.name, arguments: b.args || '{}' } } };
    }
    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done' };
  }
}

// ---------------------------------------------------------------------------
// Factory and live model lists
// ---------------------------------------------------------------------------

export function createProviderFor(id: ProviderId, apiKey: string, fetchImpl: typeof fetch = fetch): ChatProvider {
  if (testProvider) return testProvider;
  const name = PROVIDERS[id].name;
  switch (id) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, fetchImpl);
    case 'openai':
      return new OpenAICompatProvider({ id, name, baseUrl: BASE_URLS.openai, apiKey, tokenParam: 'max_completion_tokens', fetchImpl });
    case 'deepseek':
      return new OpenAICompatProvider({ id, name, baseUrl: BASE_URLS.deepseek, apiKey, echoReasoning: true, vision: false, fetchImpl });
    default:
      return new OpenAICompatProvider({ id, name, baseUrl: BASE_URLS[id], apiKey, fetchImpl });
  }
}

export interface ModelInfo {
  id: string;
  name: string;
}

const EXCLUDE: Record<ProviderId, RegExp> = {
  openai: /embed|tts|whisper|dall-e|davinci|babbage|image|audio|realtime|transcribe|moderation|search|codex|sora|instruct/i,
  anthropic: /^$/,
  google: /embed|imagen|veo|tts|image|aqa|live|audio|lyria|robotics|computer-use|native/i,
  xai: /image|imagine|video|voice|embed|vision-beta/i,
  deepseek: /^$/,
};

/** Keeps chat-capable models and drops embedding/image/audio/etc. Exported for tests. */
export function filterModels(id: ProviderId, models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models
    .map((m) => ({ id: m.id.replace(/^models\//, ''), name: m.name }))
    .filter((m) => m.id && !EXCLUDE[id].test(m.id) && !seen.has(m.id) && (seen.add(m.id), true))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Lists models with the given key. Doubles as key validation (bad keys → PROVIDER_AUTH_FAILED). */
export async function listModels(id: ProviderId, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const name = PROVIDERS[id].name;
  const url = id === 'anthropic' ? `${BASE_URLS.anthropic}/models?limit=1000` : `${BASE_URLS[id]}/models`;
  const headers: Record<string, string> =
    id === 'anthropic' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` };
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (e) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', `${name} could not be reached: ${(e as Error).message}`, true);
  }
  if (!res.ok) throw await httpError(name, res);
  const json: any = await res.json().catch(() => ({}));
  const raw: any[] = json.data ?? json.models ?? [];
  const models = raw.map((m) => ({ id: String(m.id ?? m.name ?? ''), name: String(m.display_name ?? m.displayName ?? m.id ?? m.name ?? '') }));
  return filterModels(id, models);
}

/** Last four characters only; the key itself is never returned to clients. */
export function keyHint(apiKey: string) {
  return apiKey.trim().slice(-4);
}

// ---------------------------------------------------------------------------
// Mock provider: deterministic, tests only.
// ---------------------------------------------------------------------------

export type MockScript = (req: ChatRequest) => ChatEvent[];

export class MockProvider implements ChatProvider {
  id = 'mock';
  capabilities = { tools: true, streaming: true, vision: true };
  calls: ChatRequest[] = [];
  constructor(private script: MockScript) {}
  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.calls.push(structuredClone(req));
    for (const e of this.script(req)) yield e;
  }
}

let testProvider: ChatProvider | null = null;
export function setTestProvider(p: ChatProvider | null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test providers are only allowed under NODE_ENV=test');
  testProvider = p;
}
export function getTestProvider() {
  return testProvider;
}

/** Server-wide gateway provider (legacy; only if NEON_AI_GATEWAY_* is set). */
export function createProvider(env: Record<string, string | undefined>): ChatProvider | null {
  if (testProvider) return testProvider;
  const base = env.NEON_AI_GATEWAY_BASE_URL;
  const token = env.NEON_AI_GATEWAY_TOKEN;
  if (!base || !token) return null;
  return new NeonGatewayProvider(base, token);
}

/** Collects a full (non-streamed) completion, for structured tasks like onboarding analysis. */
export async function complete(p: ChatProvider, req: ChatRequest, signal?: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const e of p.stream(req, signal)) {
    if (e.type === 'token') text += e.text;
    if (e.type === 'usage') {
      inputTokens = e.inputTokens;
      outputTokens = e.outputTokens;
    }
  }
  return { text, inputTokens, outputTokens };
}

/** Extract the first JSON object from model text (models sometimes wrap it in fences). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
