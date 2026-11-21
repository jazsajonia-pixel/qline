/**
 * v1.12 live conversation (docs/30): spoken tokens, real cancellation of a run mid-stream (barge-in), stale replies
 * never stored after a cancel, and what the model is told about an interrupted reply. Real Postgres as the app
 * role (RLS on); the model is a scripted provider that streams slowly and honours the abort signal.
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import('../src/core/db');
let ai: typeof import('@qline/ai');

const headers = (w: Who, json = false) => ({ authorization: `Bearer ${w.token}`, 'x-qline-org': w.org!, ...(json ? { 'content-type': 'application/json' } : {}) });

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = who ? headers(who, body !== undefined) : body !== undefined ? { 'content-type': 'application/json' } : {};
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

const asOrg = <T>(w: Who, fn: (q: import('../src/core/db').Q) => Promise<T>) => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);

async function setup(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, 'POST', '/auth/sign-up/email', { email, password: 'correct-horse-battery', name });
  expect(r.status).toBe(200);
  const w: Who = { token: r.json.token };
  w.org = (await call(w, 'POST', '/orgs', { name: `${name} Co` })).json.id;
  w.userId = (await call(w, 'GET', '/me')).json.user.id;
  const { seal } = await import('../src/core/secrets');
  const { aad } = await import('../src/agent/models');
  await asOrg(w, (q) =>
    q.exec(`insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test')`, [
      w.org,
      seal('sk-ant-test-key', aad(w.org!, 'anthropic')),
      JSON.stringify([{ id: 'claude-test', name: 'Claude Test' }]),
    ]),
  );
  expect((await call(w, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(200);
  return w;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams [tokens] one by one with [gapMs] between them; stops (like a real HTTP stream) when the signal aborts. */
class SlowProvider {
  id = 'mock';
  capabilities = { tools: true, streaming: true, vision: true };
  calls: { messages: { role: string; content: string }[] }[] = [];
  yielded = 0;
  aborted = false;
  constructor(
    private tokens: (req: any) => string[],
    private gapMs = 60,
  ) {}
  async *stream(req: any, signal?: AbortSignal): AsyncIterable<any> {
    this.calls.push({ messages: req.messages.map((m: any) => ({ role: m.role, content: String(m.content ?? '') })) });
    for (const t of this.tokens(req)) {
      if (signal?.aborted) {
        this.aborted = true;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      this.yielded += 1;
      yield { type: 'token', text: t };
      await sleep(this.gapMs);
    }
    yield { type: 'done' };
  }
}

type Sse = { event: string; data: any; id?: string };
/** Opens the run stream and collects events as they arrive; [until] resolves once an event matches. */
function openStream(w: Who, runId: string) {
  const events: Sse[] = [];
  const waiters: { test: (e: Sse) => boolean; resolve: () => void }[] = [];
  const done = (async () => {
    const res = await app.fetch(new Request(`http://localhost/v1/runs/${runId}/stream`, { headers: headers(w) }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const e: Sse = { event: 'message', data: null };
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) e.event = line.slice(6).trim();
          else if (line.startsWith('data:')) e.data = JSON.parse(line.slice(5).trim());
          else if (line.startsWith('id:')) e.id = line.slice(3).trim();
        }
        events.push(e);
        for (const wt of [...waiters]) if (wt.test(e)) wt.resolve();
      }
    }
  })();
  const until = (test: (e: Sse) => boolean) => (events.some(test) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve })));
  return { events, done, until };
}

const LIVE = { mode: 'live', lang: 'en-PH', confidence: 0.9 };

d('v1.12 live conversation: streaming speech and real interruption (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    ai = await import('@qline/ai');
    A = await setup('Lakan');
    B = await setup('Dayang');
  });
  afterAll(async () => {
    ai.setTestProvider(null);
    await db.closePool();
  });

  it('a live voice turn gets the live instructions; tokens before <qline-screen> are marked spoken, details after it are not', async () => {
    const p = new SlowProvider(() => ['You have three ', 'meetings today. ', 'The first is at nine.\n<qline', '-screen>\n- 9:00 Standup\n', '- 13:00 Supplier'], 5);
    ai.setTestProvider(p as any);
    const conv = (await call(A, 'POST', '/conversations', {})).json.id;
    const m = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'what is on my calendar', voice: LIVE });
    expect(m.status).toBe(202);
    const s = openStream(A, m.json.runId);
    await s.done;
    const system = p.calls[0]!.messages[0]!.content;
    expect(system).toContain('This is a live spoken conversation');
    expect(system).toContain('<qline-screen>');
    expect(system).not.toContain('<qline-say>');
    const tokens = s.events.filter((e) => e.event === 'token').map((e) => e.data);
    const spoken = tokens.filter((t) => t.say).map((t) => t.text).join('');
    const shown = tokens.map((t) => t.text).join('');
    expect(spoken.trim()).toBe('You have three meetings today. The first is at nine.');
    expect(shown).not.toContain('qline-screen');
    expect(shown).toContain('- 9:00 Standup');
    expect(tokens.filter((t) => !t.say).map((t) => t.text).join('')).toContain('13:00 Supplier');
    const done = s.events.find((e) => e.event === 'done')!.data;
    expect(done.status).toBe('completed');
    expect(typeof done.timing.firstTokenMs).toBe('number');
    const msgs = (await call(A, 'GET', `/conversations/${conv}`)).json.messages;
    expect(msgs.at(-1).content).toContain('The first is at nine.\n\n- 9:00 Standup');
    expect(msgs.at(-1).content).not.toContain('qline-screen');
  });

  it('a normal (typed) turn is unchanged: no say flags, no live instructions', async () => {
    const p = new SlowProvider(() => ['Hello ', 'there.'], 1);
    ai.setTestProvider(p as any);
    const conv = (await call(A, 'POST', '/conversations', {})).json.id;
    const m = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'hi' });
    const s = openStream(A, m.json.runId);
    await s.done;
    expect(p.calls[0]!.messages[0]!.content).not.toContain('live spoken conversation');
    expect(s.events.filter((e) => e.event === 'token').every((e) => e.data.say === undefined)).toBe(true);
  });

  it('barge-in: cancel stops generation mid-stream, keeps what was streamed as interrupted (with what was heard), and the old reply never lands later', async () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i} `);
    const p = new SlowProvider(() => words, 40);
    ai.setTestProvider(p as any);
    const conv = (await call(A, 'POST', `/conversations`, {})).json.id;
    const m = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'tell me a long story', voice: LIVE });
    const runId = m.json.runId;
    const s = openStream(A, runId);
    await s.until((e) => e.event === 'token' && String(e.data.text).includes('word4 '));
    const t0 = Date.now();
    const c = await call(A, 'POST', `/runs/${runId}/cancel`, { heard: 'word0 word1 word2', reason: 'barge_in' });
    expect(c.status).toBe(200);
    expect(c.json.state).toBe('cancelled');
    await s.done;
    const stopMs = Date.now() - t0;
    // Generation really stopped: the provider saw the abort long before the 60 tokens were out.
    expect(p.aborted).toBe(true);
    expect(p.yielded).toBeLessThan(30);
    expect(stopMs).toBeLessThan(1500);
    const done = s.events.find((e) => e.event === 'done');
    expect(done?.data.status).toBe('cancelled');
    // Give a stale writer every chance to (wrongly) store the reply, then check nothing changed.
    await sleep(300);
    const run = await asOrg(A, (q) => q.one('select status from agent_runs where id=$1', [runId]));
    expect(run!.status).toBe('cancelled');
    const msgs = (await call(A, 'GET', `/conversations/${conv}`)).json.messages.filter((x: any) => x.role === 'assistant');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].meta.interrupted).toBe(true);
    expect(msgs[0].meta.heard).toBe('word0 word1 word2');
    expect(msgs[0].content.startsWith('word0 word1')).toBe(true);
    expect(msgs[0].content).not.toContain('word59');

    // The next request is accepted at once (no "already answering"), and the model is told what was heard.
    const p2 = new SlowProvider(() => ['Sure, ', 'shorter.'], 1);
    ai.setTestProvider(p2 as any);
    const m2 = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'make it shorter', voice: LIVE });
    expect(m2.status).toBe(202);
    await openStream(A, m2.json.runId).done;
    const hist = p2.calls[0]!.messages;
    const interrupted = hist.find((x) => x.role === 'assistant')!;
    expect(interrupted.content).toContain('interrupted by the user; they heard only: "word0 word1 word2"');
    expect(hist.at(-1)!.content).toBe('make it shorter');
    // Order: the interrupted reply sorts before the new user message.
    const all = (await call(A, 'GET', `/conversations/${conv}`)).json.messages.map((x: any) => `${x.role}:${x.meta?.interrupted ? 'interrupted' : x.content.slice(0, 12)}`);
    expect(all).toEqual(['user:tell me a lo', 'assistant:interrupted', 'user:make it shor', 'assistant:Sure, shorte']);
  });

  it('a cancel found by the status watch (another instance) also stops the model', async () => {
    const p = new SlowProvider(() => Array.from({ length: 80 }, (_, i) => `t${i} `), 40);
    ai.setTestProvider(p as any);
    const conv = (await call(A, 'POST', '/conversations', {})).json.id;
    const m = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'go', voice: LIVE });
    const s = openStream(A, m.json.runId);
    await s.until((e) => e.event === 'token');
    // Cancel straight in the database, the way a cancel handled by another instance looks from here.
    await asOrg(A, (q) => q.exec(`update agent_runs set status='cancelled', ended_at=now() where id=$1`, [m.json.runId]));
    await s.done;
    expect(p.aborted).toBe(true);
    expect(p.yielded).toBeLessThan(40);
    expect((await asOrg(A, (q) => q.one('select status from agent_runs where id=$1', [m.json.runId])))!.status).toBe('cancelled');
  });

  it('talking over a reply that already finished notes what was heard; cancels are owner-only', async () => {
    const p = new SlowProvider(() => ['All done here.'], 1);
    ai.setTestProvider(p as any);
    const conv = (await call(A, 'POST', '/conversations', {})).json.id;
    const m = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'status?', voice: LIVE });
    await openStream(A, m.json.runId).done;
    expect((await call(B, 'POST', `/runs/${m.json.runId}/cancel`, { heard: 'x' })).status).toBe(404);
    const c = await call(A, 'POST', `/runs/${m.json.runId}/cancel`, { heard: 'All done', reason: 'barge_in' });
    expect(c.status).toBe(200);
    expect(c.json.state).toBe('finished');
    const msg = (await call(A, 'GET', `/conversations/${conv}`)).json.messages.find((x: any) => x.role === 'assistant');
    expect(msg.meta.heard).toBe('All done');
    expect(msg.meta.interrupted).toBe(true);
    expect((await asOrg(A, (q) => q.one('select status from agent_runs where id=$1', [m.json.runId])))!.status).toBe('completed');
    // The old phone app cancels with no body at all: still accepted.
    const m2 = await call(A, 'POST', `/conversations/${conv}/messages`, { content: 'again' });
    expect((await call(A, 'POST', `/runs/${m2.json.runId}/cancel`)).status).toBe(200);
  });
});
