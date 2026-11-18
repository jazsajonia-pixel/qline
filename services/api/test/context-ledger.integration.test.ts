/**
 * M2 chat continuity and context reuse (docs/18) against a real Postgres, as the app role (RLS enforced).
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

/** The model asks for `tool(args)` once per user message, then answers. System prompts are kept for inspection. */
let systems: string[] = [];
function script(tool: string, args: unknown) {
  systems = [];
  ai.setTestProvider(
    new ai.MockProvider((req) => {
      const lastUser = req.messages.map((m) => m.role).lastIndexOf("user");
      if (!req.messages.slice(lastUser).some((m) => m.role === "tool")) {
        systems.push(String(req.messages[0]!.content));
        return [
          {
            type: "tool_call",
            call: {
              id: randomUUID(),
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          },
          { type: "done" },
        ];
      }
      return [{ type: "token", text: "Here you go." }, { type: "done" }];
    }),
  );
}

const newConv = async (w: Who) =>
  (await call(w, "POST", "/conversations", {})).json.id as string;

async function say(
  w: Who,
  conv: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const m = await call(w, "POST", `/conversations/${conv}/messages`, {
    content,
    ...extra,
  });
  expect(m.status).toBe(202);
  const st = await app.fetch(
    new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, {
      headers: { authorization: `Bearer ${w.token}`, "x-qline-org": w.org! },
    }),
  );
  const sse = await st.text();
  const tc = await asOrg(w, (q) =>
    q.one<{
      id: string;
      status: string;
      reused_context_id: string | null;
      result_summary: string;
    }>(
      "select id, status, reused_context_id, result_summary from tool_calls where run_id=$1",
      [m.json.runId],
    ),
  );
  return {
    sse,
    runId: m.json.runId as string,
    tc: tc!,
    reused: !!tc!.reused_context_id,
  };
}

const addTask = (w: Who, title: string) => call(w, "POST", "/tasks", { title });

d("M2 chat continuity and context reuse (integration)", () => {
  let A: Who;
  let B: Who;
  const realFetch = globalThis.fetch;
  let ghRequests = 0;
  beforeAll(async () => {
    app = (await import("../src/index")).default as any;
    db = await import("../src/core/db");
    ai = await import("@qline/ai");
    A = await setup("Ligaya");
    B = await setup("Dakila");
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith("https://api.github.com/"))
        return realFetch(input, init);
      ghRequests++;
      const body = url.includes("/repositories")
        ? {
            repositories: [
              {
                full_name: "acme/site",
                private: false,
                open_issues_count: 2,
                html_url: "https://github.com/acme/site",
              },
            ],
          }
        : { installations: [{ id: 7 }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    ai.setTestProvider(null);
    await db.closePool();
  });

  it("reuses an identical read in the next message, and the model is told what it already has", async () => {
    expect((await addTask(A, "Send the Davao quote")).status).toBe(201);
    script("tasks__search", { status: "open" });
    const conv = await newConv(A);
    const first = await say(A, conv, "What tasks are open?");
    expect(first.reused).toBe(false);
    expect(first.tc.status).toBe("succeeded");
    script("tasks__search", { status: "open" });
    const second = await say(A, conv, "Which of those are open, in short?");
    expect(second.reused).toBe(true);
    expect(second.tc.status).toBe("succeeded");
    expect(second.sse).toContain('"reused":true');
    expect(second.sse).toContain("from earlier in this chat");
    expect(systems[0]).toContain('source="conversation_context"');
    expect(systems[0]).toContain("tasks.search");
    // The saved result is the same data the first call returned.
    const e = await asOrg(A, (q) =>
      q.one(
        "select data, hits, source_tool_call_id from conversation_context where id=$1",
        [second.tc.reused_context_id],
      ),
    );
    expect(e!.hits).toBe(1);
    expect(e!.source_tool_call_id).toBe(first.tc.id);
    expect(JSON.stringify(e!.data)).toContain("Send the Davao quote");
  });

  it("a change to the data (any write path) invalidates it; the next read sees the change", async () => {
    script("tasks__search", { status: "open" });
    const conv = await newConv(A);
    await say(A, conv, "What tasks are open?");
    expect((await say(A, conv, "Show them once more")).reused).toBe(true);
    // Through the API…
    expect((await addTask(A, "Call Mindanao supplier")).status).toBe(201);
    const after = await say(A, conv, "Show them once more");
    expect(after.reused).toBe(false);
    expect(after.tc.result_summary).toBeTruthy();
    const latest = await asOrg(A, (q) =>
      q.one(
        "select data from conversation_context where conversation_id=$1 and tool='tasks.search' and invalidated_at is null",
        [conv],
      ),
    );
    expect(JSON.stringify(latest!.data)).toContain("Call Mindanao supplier");
    // …and directly in the database (imports, syncs, workflows all count).
    expect((await say(A, conv, "Once more")).reused).toBe(true);
    await asOrg(A, (q) =>
      q.exec(
        "update tasks set title=title || ' (edited)' where org_id=$1 and title='Call Mindanao supplier'",
        [A.org],
      ),
    );
    expect((await say(A, conv, "Once more")).reused).toBe(false);
    // A change to an unrelated table does not invalidate it.
    await asOrg(A, (q) =>
      q.exec(
        "insert into contacts (org_id, workspace_id, name, created_by) values ($1,$2,'Unrelated',$3)",
        [A.org, A.ws, A.userId],
      ),
    );
    expect((await say(A, conv, "Once more")).reused).toBe(true);
  });

  it("asking for fresh data, the fresh flag, and expiry all bypass reuse", async () => {
    script("tasks__search", { status: "open" });
    const conv = await newConv(A);
    await say(A, conv, "What tasks are open?");
    const refreshed = await say(A, conv, "Refresh that list");
    expect(refreshed.reused).toBe(false);
    expect(systems.at(-1)).toContain(
      "every lookup in this reply runs again now",
    );
    expect((await say(A, conv, "Check mo ulit")).reused).toBe(false);
    expect((await say(A, conv, "The list", { fresh: true })).reused).toBe(
      false,
    );
    expect((await say(A, conv, "The list")).reused).toBe(true);
    await asOrg(A, (q) =>
      q.exec(
        "update conversation_context set expires_at=now() - interval '1 second' where conversation_id=$1",
        [conv],
      ),
    );
    expect((await say(A, conv, "The list")).reused).toBe(false);
  });

  it("never crosses conversations, users or organisations", async () => {
    script("tasks__search", { status: "open" });
    const conv = await newConv(A);
    await say(A, conv, "What tasks are open?");
    expect(
      (await say(A, await newConv(A), "What tasks are open?")).reused,
    ).toBe(false);
    expect(
      (await say(B, await newConv(B), "What tasks are open?")).reused,
    ).toBe(false);
    // B cannot read A's ledger or change log, even by id.
    expect(
      await asOrg(B, (q) =>
        q.many("select id from conversation_context where conversation_id=$1", [
          conv,
        ]),
      ),
    ).toEqual([]);
    expect(
      await asOrg(B, (q) =>
        q.many("select id from data_changes where org_id=$1", [A.org]),
      ),
    ).toEqual([]);
    // B cannot read A's conversation or its context endpoint.
    expect((await call(B, "GET", `/conversations/${conv}`)).status).toBe(404);
    expect(
      (await call(B, "GET", `/conversations/${conv}/context`)).status,
    ).toBe(404);
  });

  it("a connected-app read is reused without calling the provider; a write to that app invalidates it", async () => {
    const { sealTokens } = await import("../src/integrations/oauth");
    await asOrg(A, (q) =>
      q.exec(
        `insert into integration_connections (org_id, workspace_id, provider, status, connected_by, token_ciphertext, settings) values ($1,$2,'github','ok',$3,$4,'{}')`,
        [
          A.org,
          A.ws,
          A.userId,
          sealTokens(A.org!, "github", { access_token: "ghu-test" } as any),
        ],
      ),
    );
    script("github__repos", {});
    const conv = await newConv(A);
    ghRequests = 0;
    const first = await say(A, conv, "Which repos can you see?");
    expect(first.tc.status).toBe("succeeded");
    expect(ghRequests).toBe(2);
    expect((await say(A, conv, "List the repos briefly")).reused).toBe(true);
    expect(ghRequests).toBe(2);
    const ctx = (await call(A, "GET", `/conversations/${conv}/context`)).json;
    expect(ctx.savings.reusedCalls).toBe(1);
    expect(ctx.savings.providerRequestsAvoided).toBe(2);
    expect(ctx.savings.resultCharsReused).toBeGreaterThan(0);
    // Qline wrote to GitHub since: read it again.
    await asOrg(A, (q) =>
      q.exec(
        `insert into tool_calls (org_id, tool, args, risk, policy_decision, idempotency_key, status, finished_at) values ($1,'github.issue.create','{}','L2','allow',$2,'succeeded',now())`,
        [A.org, `test:${randomUUID()}`],
      ),
    );
    expect((await say(A, conv, "List the repos briefly")).reused).toBe(false);
    expect(ghRequests).toBe(4);
  });

  it("reopening: shows an answer still in progress, and a dead run no longer blocks the conversation", async () => {
    script("tasks__search", { status: "open" });
    const conv = await newConv(A);
    const m = await call(A, "POST", `/conversations/${conv}/messages`, {
      content: "What is open?",
    });
    expect(m.status).toBe(202);
    const open = (await call(A, "GET", `/conversations/${conv}`)).json;
    expect(open.active_run).toMatchObject({
      id: m.json.runId,
      status: "queued",
    });
    // The app died before streaming; 10 minutes later the run is still "queued".
    await asOrg(A, (q) =>
      q.exec(
        "update agent_runs set created_at=now() - interval '10 minutes' where id=$1",
        [m.json.runId],
      ),
    );
    const later = (await call(A, "GET", `/conversations/${conv}`)).json;
    expect(later.active_run).toBeNull();
    expect(later.messages.at(-1)).toMatchObject({
      role: "system_notice",
      content: expect.stringContaining("interrupted"),
    });
    // A run left "running" by a crash used to block the conversation with 409 forever.
    const r = await say(A, conv, "What is open?");
    await asOrg(A, (q) =>
      q.exec(
        "update agent_runs set status='running', started_at=now() - interval '10 minutes' where id=$1",
        [r.runId],
      ),
    );
    const again = await call(A, "POST", `/conversations/${conv}/messages`, {
      content: "Still there?",
    });
    expect(again.status).toBe(202);
    expect(
      (await asOrg(A, (q) =>
        q.one("select status, error from agent_runs where id=$1", [r.runId]),
      ))!,
    ).toMatchObject({ status: "failed", error: "Interrupted" });
    // A run that is genuinely in progress still blocks a second message.
    expect(
      (
        await call(A, "POST", `/conversations/${conv}/messages`, {
          content: "Hello?",
        })
      ).status,
    ).toBe(409);
  });

  it("lists and opens only conversations of the current workspace", async () => {
    const other = await asOrg(A, (q) =>
      q.one<{ id: string }>(
        "insert into workspaces (org_id, name) values ($1,'Other') returning id",
        [A.org],
      ),
    );
    const agent = await asOrg(A, (q) =>
      q.one<{ id: string }>(
        "select id from agents where workspace_id=$1 limit 1",
        [A.ws],
      ),
    );
    const hidden = await asOrg(A, (q) =>
      q.one<{ id: string }>(
        "insert into conversations (org_id, workspace_id, agent_id, user_id, title) values ($1,$2,$3,$4,'Elsewhere') returning id",
        [A.org, other!.id, agent!.id, A.userId],
      ),
    );
    const list = (await call(A, "GET", "/conversations")).json.items as {
      id: string;
    }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((c) => c.id)).not.toContain(hidden!.id);
    expect((await call(A, "GET", `/conversations/${hidden!.id}`)).status).toBe(
      404,
    );
    expect(
      (
        await call(A, "POST", `/conversations/${hidden!.id}/messages`, {
          content: "hi",
        })
      ).status,
    ).toBe(404);
  });

  it("the scheduler purge removes expired entries", async () => {
    const { purgeLedger } = await import("../src/agent/context-ledger");
    await asOrg(A, (q) =>
      q.exec(
        "update conversation_context set expires_at=now() - interval '1 hour' where org_id=$1",
        [A.org],
      ),
    );
    expect(await purgeLedger()).toBeGreaterThan(0);
    expect(
      await asOrg(A, (q) =>
        q.many("select id from conversation_context where org_id=$1", [A.org]),
      ),
    ).toEqual([]);
  });
});
