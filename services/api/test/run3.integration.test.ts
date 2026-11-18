/**
 * Run 3: knowledge added to a message, friendly tool labels (docs/19) against a real Postgres, as the app role (RLS enforced).
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = "test";
process.env.QLINE_RUNTIME_KICK = "0";

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import("../src/core/db");
let ai: typeof import("@qline/ai");

async function call(
  who: Who | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${who.token}`;
  if (who?.org) headers["x-qline-org"] = who.org;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://localhost/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

const asOrg = <T>(w: Who, fn: (q: import("../src/core/db").Q) => Promise<T>) =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);

async function setup(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, "POST", "/auth/sign-up/email", {
    email,
    password: "correct-horse-battery",
    name,
  });
  expect(r.status).toBe(200);
  const w: Who = { token: r.json.token };
  w.org = (await call(w, "POST", "/orgs", { name: `${name} Co` })).json.id;
  w.userId = (await call(w, "GET", "/me")).json.user.id;
  w.ws = (await asOrg(w, (q) =>
    q.one("select id from workspaces where org_id=$1", [w.org]),
  ))!.id;
  await useModel(w);
  return w;
}

async function useModel(w: Who) {
  const { seal } = await import("../src/core/secrets");
  const { aad } = await import("../src/agent/models");
  await asOrg(w, (q) =>
    q.exec(
      `insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test')`,
      [
        w.org,
        seal("sk-ant-test-key", aad(w.org!, "anthropic")),
        JSON.stringify([{ id: "claude-test", name: "Claude Test" }]),
      ],
    ),
  );
  expect(
    (
      await call(w, "PUT", "/ai/default", {
        provider: "anthropic",
        model: "claude-test",
      })
    ).status,
  ).toBe(200);
}

let seen: { role: string; content: string }[][] = [];
/** The model reads tasks once, then answers. Every request is kept so we can see what the model was given. */
function script(tool?: string) {
  seen = [];
  ai.setTestProvider(
    new ai.MockProvider((req) => {
      seen.push(req.messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })));
      const lastUser = req.messages.map((m) => m.role).lastIndexOf('user');
      if (tool && !req.messages.slice(lastUser).some((m) => m.role === 'tool')) {
        return [
          { type: 'tool_call', call: { id: randomUUID(), type: 'function', function: { name: tool, arguments: '{}' } } },
          { type: 'done' },
        ];
      }
      return [{ type: 'token', text: 'Noted.' }, { type: 'done' }];
    }),
  );
}

async function say(w: Who, conv: string, content: string, extra: Record<string, unknown> = {}) {
  const m = await call(w, 'POST', `/conversations/${conv}/messages`, { content, ...extra });
  if (m.status !== 202) return { status: m.status, json: m.json, sse: '' };
  const st = await app.fetch(
    new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, { headers: { authorization: `Bearer ${w.token}`, 'x-qline-org': w.org! } }),
  );
  return { status: m.status, json: m.json, sse: await st.text() };
}

d('Run 3: chat output and knowledge context (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    ai = await import('@qline/ai');
    A = await setup('Tala');
    B = await setup('Bayani');
  });
  afterAll(async () => {
    ai.setTestProvider(null);
    await db.closePool();
  });

  it('a knowledge entry added to a message reaches the model as untrusted context and is recorded on the message', async () => {
    const e = await call(A, 'POST', '/knowledge/entries', { title: 'Delivery days', body: 'We deliver to Toril on Tuesdays only.', kind: 'fact' });
    expect(e.status).toBe(201);
    script();
    const conv = (await call(A, 'POST', '/conversations', {})).json.id;
    const r = await say(A, conv, 'When can we deliver to Toril?', { knowledge: [e.json.id] });
    expect(r.status).toBe(202);
    const user = seen[0]!.filter((m) => m.role === 'user').at(-1)!.content;
    expect(user).toContain('We deliver to Toril on Tuesdays only.');
    expect(user).toContain(`knowledge:${e.json.id}`);
    const msgs = (await call(A, 'GET', `/conversations/${conv}`)).json.messages;
    const sent = msgs.find((m: any) => m.role === 'user');
    expect(sent.meta.knowledge).toEqual([{ id: e.json.id, title: 'Delivery days', status: 'active' }]);
    // A later message without knowledge still carries the earlier one in its history, once.
    script();
    await say(A, conv, 'Thanks');
    const all = seen[0]!.map((m) => m.content).join('\n');
    expect(all.split('We deliver to Toril on Tuesdays only.').length - 1).toBe(1);
  });

  it("another org's entry, an unknown id and more than five entries are refused", async () => {
    const e = await call(A, 'POST', '/knowledge/entries', { title: 'Secret margin', body: '40%', kind: 'fact' });
    const conv = (await call(B, 'POST', '/conversations', {})).json.id;
    script();
    expect((await say(B, conv, 'hi', { knowledge: [e.json.id] })).status).toBe(404);
    expect((await say(B, conv, 'hi', { knowledge: [randomUUID()] })).status).toBe(404);
    expect((await say(B, conv, 'hi', { knowledge: Array.from({ length: 6 }, () => randomUUID()) })).status).toBe(400);
  });

  it('tool steps carry friendly labels in the stream and in the run record, never only the tool id', async () => {
    script('tasks__search');
    const conv = (await call(A, 'POST', '/conversations', {})).json.id;
    const r = await say(A, conv, 'What is open?');
    expect(r.sse).toContain('"running":"Checking your tasks"');
    expect(r.sse).toContain('"done":"Checked your tasks"');
    const run = await call(A, 'GET', `/runs/${r.json.runId}`);
    expect(run.status).toBe(200);
    const step = run.json.toolCalls[0];
    expect(step).toMatchObject({ tool: 'tasks.search', done: 'Checked your tasks' });
    expect(step).not.toHaveProperty('args');
  });
});
