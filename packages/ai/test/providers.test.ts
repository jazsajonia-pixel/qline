import { describe, expect, it } from 'vitest';
import { AnthropicProvider, createProviderFor, filterModels, keyHint, listModels, OpenAICompatProvider, ProviderError, type ChatEvent } from '../src/index';

function sse(lines: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(String(url), init);
  }) as typeof fetch;
  return { f, calls };
}
async function collect(it: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const tools = [{ name: 'tasks__search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];

describe('OpenAI-compatible providers', () => {
  it('streams tokens, tool calls with Gemini extra_content, and usage; echoes them back', async () => {
    const { f, calls } = fakeFetch(
      () =>
        new Response(
          sse([
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"tasks__search","arguments":"{\\"query\\":"},"extra_content":{"google":{"thought_signature":"sig"}}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200 },
        ),
    );
    const p = createProviderFor('google', 'AIzaTESTKEY', f);
    const ev = await collect(p.stream({ model: 'gemini-x', messages: [{ role: 'user', content: 'hi' }], tools, maxTokens: 50 }));
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((calls[0].init.headers as any).authorization).toBe('Bearer AIzaTESTKEY');
    expect(calls[0].body.max_tokens).toBe(50);
    expect(calls[0].body.parallel_tool_calls).toBeUndefined();
    const call = ev.find((e) => e.type === 'tool_call') as any;
    expect(call.call).toMatchObject({ id: 'c1', function: { name: 'tasks__search', arguments: '{"query":"x"}' }, extra_content: { google: { thought_signature: 'sig' } } });
    expect(ev).toContainEqual({ type: 'token', text: 'Hi' });
    expect(ev).toContainEqual({ type: 'usage', inputTokens: 7, outputTokens: 3 });
    const body = (p as OpenAICompatProvider).buildBody({ model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [call.call] }] });
    expect((body.messages as any)[0].tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig' } });
  });

  it('OpenAI uses max_completion_tokens; DeepSeek echoes reasoning_content on tool-call turns', () => {
    const o = createProviderFor('openai', 'sk-test') as OpenAICompatProvider;
    expect(o.buildBody({ model: 'm', messages: [], maxTokens: 9 }).max_completion_tokens).toBe(9);
    const d = createProviderFor('deepseek', 'sk-test') as OpenAICompatProvider;
    const b = d.buildBody({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'assistant', content: null, reasoning_content: 'thinking', tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] }],
    });
    expect((b.messages as any)[0].reasoning_content).toBe('thinking');
    const g = createProviderFor('google', 'k') as OpenAICompatProvider;
    const gb = g.buildBody({ model: 'm', messages: [{ role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] }] });
    expect((gb.messages as any)[0].reasoning_content).toBeUndefined();
  });

  it('maps HTTP errors to provider error codes', async () => {
    const mk = (status: number, body: unknown) => createProviderFor('xai', 'xai-k', fakeFetch(() => new Response(JSON.stringify(body), { status })).f);
    await expect(collect(mk(401, { error: { message: 'Incorrect API key' } }).stream({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    await expect(collect(mk(429, { error: { message: 'slow down' } }).stream({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });
    await expect(collect(mk(503, { error: { message: 'down' } }).stream({ model: 'm', messages: [] }))).rejects.toBeInstanceOf(ProviderError);
    // Gemini returns 400 for a bad key, in an array envelope
    const g = createProviderFor('google', 'bad', fakeFetch(() => new Response(JSON.stringify([{ error: { message: 'API key not valid. Please pass a valid API key.' } }]), { status: 400 })).f);
    await expect(collect(g.stream({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });
});

describe('Anthropic provider', () => {
  it('converts messages (system top-level, tool_use/tool_result) and parses the stream', async () => {
    const { f, calls } = fakeFetch(
      () =>
        new Response(
          sse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking"}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"tasks__search","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\": \\"a\\"}"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
          { status: 200 },
        ),
    );
    const p = new AnthropicProvider('sk-ant-test', f);
    const ev = await collect(
      p.stream({
        model: 'claude-x',
        tools,
        messages: [
          { role: 'system', content: 'Be brief' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: null, tool_calls: [{ id: 't0', type: 'function', function: { name: 'tasks__search', arguments: '{"query":"b"}' } }] },
          { role: 'tool', tool_call_id: 't0', content: 'result' },
          { role: 'tool', tool_call_id: 't0b', content: 'result2' },
        ],
      }),
    );
    const b = calls[0].body;
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect((calls[0].init.headers as any)['x-api-key']).toBe('sk-ant-test');
    expect((calls[0].init.headers as any)['anthropic-version']).toBe('2023-06-01');
    expect(b.system).toBe('Be brief');
    expect(b.max_tokens).toBeGreaterThan(0);
    expect(b.tools[0]).toEqual({ name: 'tasks__search', description: 'Search', input_schema: tools[0].parameters });
    expect(b.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(b.messages[1].content[0]).toEqual({ type: 'tool_use', id: 't0', name: 'tasks__search', input: { query: 'b' } });
    expect(b.messages[2].content).toHaveLength(2); // consecutive tool results merged into one user turn
    expect(ev).toContainEqual({ type: 'token', text: 'Looking' });
    expect(ev).toContainEqual({ type: 'tool_call', call: { id: 'toolu_1', type: 'function', function: { name: 'tasks__search', arguments: '{"query": "a"}' } } });
    expect(ev).toContainEqual({ type: 'usage', inputTokens: 11, outputTokens: 20 });
  });
});

describe('model lists', () => {
  it('filters non-chat models and strips the models/ prefix', () => {
    expect(filterModels('google', [{ id: 'models/gemini-4-pro', name: '' }, { id: 'models/text-embedding-004', name: '' }, { id: 'models/imagen-4', name: '' }]).map((m) => m.id)).toEqual(['gemini-4-pro']);
    expect(filterModels('openai', [{ id: 'gpt-6', name: '' }, { id: 'whisper-1', name: '' }, { id: 'text-embedding-3-large', name: '' }, { id: 'gpt-image-2', name: '' }]).map((m) => m.id)).toEqual(['gpt-6']);
    expect(filterModels('xai', [{ id: 'grok-4.7', name: '' }, { id: 'grok-imagine-video', name: '' }]).map((m) => m.id)).toEqual(['grok-4.7']);
  });
  it('lists Anthropic models with the native headers, and rejects bad keys', async () => {
    const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }), { status: 200 }));
    expect(await listModels('anthropic', 'sk-ant-k', f)).toEqual([{ id: 'claude-x', name: 'Claude X' }]);
    expect(calls[0].url).toContain('https://api.anthropic.com/v1/models');
    const bad = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })).f;
    await expect(listModels('anthropic', 'nope', bad)).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    const ds = fakeFetch(() => new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { status: 200 }));
    await listModels('deepseek', 'sk-x', ds.f);
    expect(ds.calls[0].url).toBe('https://api.deepseek.com/models');
  });
  it('only shows the last four characters of a key', () => {
    expect(keyHint('  sk-abcdefgh1234 ')).toBe('1234');
  });
});
