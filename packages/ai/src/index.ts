/**
 * Provider-neutral AI layer (docs/07 §1).
 * The only real provider today is the Neon AI Gateway (OpenAI-compatible
 * chat completions). The mock provider exists for tests and is refused by
 * `createProvider` outside NODE_ENV=test, so production can never show fake
 * model output.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallReq[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCallReq {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCallReq }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done' };

export class ProviderError extends Error {
  constructor(
    public code: 'PROVIDER_NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'PROVIDER_RATE_LIMITED',
    message: string,
    public retryable = false,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export interface ChatProvider {
  id: string;
  capabilities: { tools: boolean; streaming: boolean };
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

// ---------------------------------------------------------------------------
// Neon AI Gateway (OpenAI-compatible /v1/chat/completions, SSE stream)
// ---------------------------------------------------------------------------

export class NeonGatewayProvider implements ChatProvider {
  id = 'neon-ai-gateway';
  capabilities = { tools: true, streaming: true };
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', `AI gateway could not be reached: ${(e as Error).message}`, true);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const msg = parsed?.error?.message ?? (text.slice(0, 300) || `HTTP ${res.status}`);
      if (parsed?.error?.unavailable_reason === 'paid_plan_required' || /not enabled on this account's current plan/i.test(msg)) {
        throw new ProviderError('PROVIDER_NOT_CONFIGURED', msg, false, { reason: 'paid_plan_required', recoveryUrl: parsed?.error?.recovery_url });
      }
      if (res.status === 429) throw new ProviderError('PROVIDER_RATE_LIMITED', msg, true);
      if (res.status >= 500) throw new ProviderError('PROVIDER_UNAVAILABLE', msg, true);
      throw new ProviderError('PROVIDER_REJECTED', msg, false);
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) {
          yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const content = delta.content;
        if (typeof content === 'string' && content) yield { type: 'token', text: content };
        else if (Array.isArray(content)) {
          for (const part of content) if (part?.type === 'text' && part.text) yield { type: 'token', text: part.text };
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = pending.get(i) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          pending.set(i, cur);
        }
      }
    }
    for (const [i, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'tool_call', call: { id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } } };
    }
    yield { type: 'done' };
  }
}

// ---------------------------------------------------------------------------
// Mock provider: deterministic, tests only.
// ---------------------------------------------------------------------------

export type MockScript = (req: ChatRequest) => ChatEvent[];

export class MockProvider implements ChatProvider {
  id = 'mock';
  capabilities = { tools: true, streaming: true };
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

export function createProvider(env: Record<string, string | undefined>): ChatProvider | null {
  if (testProvider) return testProvider;
  const base = env.NEON_AI_GATEWAY_BASE_URL;
  const token = env.NEON_AI_GATEWAY_TOKEN;
  if (!base || !token) return null;
  return new NeonGatewayProvider(base, token);
}

/** Collects a full (non-streamed) completion, for structured tasks like onboarding analysis. */
export async function complete(p: ChatProvider, req: ChatRequest): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const e of p.stream(req)) {
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
