/**
 * M1 action safety (docs/17) against a real Postgres, as the app role (RLS enforced).
 * Needs QLINE_TEST_ENV; skipped otherwise. Kicks are off so every drain is explicit.
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
let C: typeof import("../src/core/controls");
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
  return w;
}

const asOrg = <T>(w: Who, fn: (q: import("../src/core/db").Q) => Promise<T>) =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);

/** A recorded, not-yet-run L3 action (what the runner commits before reserving). */
const plannedCall = (w: Who, tool = "slack.post") =>
  asOrg(w, (q) =>
    q.one<{ id: string }>(
      `insert into tool_calls (org_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,'{}','L3','allow',$3,'executing') returning id`,
      [w.org, tool, `test:${randomUUID()}`],
    ),
  ).then((r) => r!.id);

const reserve = (w: Who, id: string) =>
  asOrg(w, (q) =>
    C.reserveExternalAction(q, {
      orgId: w.org!,
      workspaceId: w.ws!,
      toolCallId: id,
      tool: "slack.post",
    }),
  );
const used = async (w: Who) =>
  (await asOrg(w, (q) =>
    q.one(
      "select count(*)::int as n from external_action_reservations where workspace_id=$1 and status <> $2",
      [w.ws, "released"],
    ),
  ))!.n as number;

async function connectSlack(w: Who) {
  const { sealTokens } = await import("../src/integrations/oauth");
  await asOrg(w, (q) =>
    q.exec(
      `insert into integration_connections (org_id, workspace_id, provider, status, connected_by, token_ciphertext, settings) values ($1,$2,'slack','ok',$3,$4,$5)`,
      [
        w.org,
        w.ws,
        w.userId,
        sealTokens(w.org!, "slack", { access_token: "xoxb-test" } as any),
        JSON.stringify({ channel: { id: "C1", name: "general" } }),
      ],
    ),
  );
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

/** A chat turn where the model asks to post to Slack once, then answers. Returns the run's SSE text. */
async function chatSlackPost(w: Who) {
  ai.setTestProvider(
    new ai.MockProvider((req) => {
      if (!req.messages.some((m) => m.role === "tool"))
        return [
          {
            type: "tool_call",
            call: {
              id: randomUUID(),
              type: "function",
              function: {
                name: "slack__post",
                arguments: JSON.stringify({ text: "Weekly update" }),
              },
            },
          },
          { type: "done" },
        ];
      return [{ type: "token", text: "Done." }, { type: "done" }];
    }),
  );
  const conv = await call(w, "POST", "/conversations", {});
  const m = await call(w, "POST", `/conversations/${conv.json.id}/messages`, {
    content: "Post the weekly update to Slack",
  });
  expect(m.status).toBe(202);
  const st = await app.fetch(
    new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, {
      headers: { authorization: `Bearer ${w.token}`, "x-qline-org": w.org! },
    }),
  );
  return { sse: await st.text(), runId: m.json.runId as string };
}

d("M1 action safety (integration)", () => {
  let A: Who;
  let B: Who;
  const realFetch = globalThis.fetch;
  let slackMode: "timeout" | "ok" = "ok";
  let posts = 0;
  beforeAll(async () => {
    app = (await import("../src/index")).default as any;
    db = await import("../src/core/db");
    C = await import("../src/core/controls");
    ai = await import("@qline/ai");
    A = await setup("Tala");
    B = await setup("Bayani");
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith("https://slack.com/")) return realFetch(input, init);
      posts++;
      if (slackMode === "timeout")
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        );
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
        status: 200,
      });
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    ai.setTestProvider(null);
    await db.closePool();
  });

  it("cap race: 10 concurrent reservations at a limit of 3 → exactly 3 succeed; other workspaces are unaffected", async () => {
    expect(
      (
        await call(A, "PUT", `/workspaces/${A.ws}/autonomy`, {
          autonomy: "full",
          dailyExternalLimit: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(B, "PUT", `/workspaces/${B.ws}/autonomy`, {
          autonomy: "full",
          dailyExternalLimit: 3,
        })
      ).status,
    ).toBe(200);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => plannedCall(A)),
    );
    const got = await Promise.all(ids.map((id) => reserve(A, id)));
    expect(got.filter(Boolean).length).toBe(3);
    expect(await used(A)).toBe(3);
    const st = (await call(A, "GET", `/workspaces/${A.ws}/autonomy`)).json;
    expect(st).toMatchObject({ autonomy: "full", dailyExternalLimit: 3 });
    // Workspace B has its own allowance, and cannot see A's ledger.
    expect(await reserve(B, await plannedCall(B))).toBe(true);
    expect(
      await asOrg(B, (q) =>
        q.many(
          "select id from external_action_reservations where workspace_id=$1",
          [A.ws],
        ),
      ),
    ).toEqual([]);
    // A definite failure gives the slot back; success and unknown keep it.
    const winners = ids.filter((_, i) => got[i]);
    await asOrg(A, (q) => C.settleReservation(q, winners[0]!, "failed"));
    await asOrg(A, (q) => C.settleReservation(q, winners[1]!, "unknown"));
    expect(await used(A)).toBe(2);
    expect(
      await reserve(
        A,
        ids.find((_, i) => !got[i])!,
      ),
    ).toBe(true);
    expect(await used(A)).toBe(3);
    // Rolling 24h window: old reservations no longer count.
    await asOrg(A, (q) =>
      q.exec(
        `update external_action_reservations set created_at = now() - interval '25 hours' where workspace_id=$1`,
        [A.ws],
      ),
    );
    expect(await used(A)).toBe(3); // the helper counts all; the cap only counts the window:
    expect(await reserve(A, await plannedCall(A))).toBe(true);
    // Not on full autopilot → never reserves.
    expect(
      (
        await call(A, "PUT", `/workspaces/${A.ws}/autonomy`, {
          autonomy: "autopilot",
        })
      ).status,
    ).toBe(200);
    expect(await reserve(A, await plannedCall(A))).toBe(false);
    await asOrg(A, (q) =>
      q.exec(`delete from external_action_reservations where workspace_id=$1`, [
        A.ws,
      ]),
    );
    await asOrg(A, (q) =>
      q.exec(`update tool_calls set status='failed' where status='executing'`),
    );
  });

  it('runner: a Slack post that times out is "unknown", uses the slot, is not retried, and a person resolves it', async () => {
    await useModel(A);
    await connectSlack(A);
    expect(
      (
        await call(A, "PUT", `/workspaces/${A.ws}/autonomy`, {
          autonomy: "full",
          dailyExternalLimit: 5,
        })
      ).status,
    ).toBe(200);
    slackMode = "timeout";
    const before = posts;
    const { sse, runId } = await chatSlackPost(A);
    expect(sse).toContain('"outcome":"unknown"');
    expect(posts - before).toBe(1);
    const tc = await asOrg(A, (q) =>
      q.one(
        `select id, status, result_summary from tool_calls where run_id=$1 and tool='slack.post'`,
        [runId],
      ),
    );
    expect(tc.status).toBe("unknown");
    expect(tc.result_summary).toMatch(/not retried/i);
    expect(await used(A)).toBe(1); // consumed: it may have happened

    const list = await call(A, "GET", "/actions/unknown");
    expect(list.status).toBe(200);
    expect(list.json.items.map((x: any) => x.id)).toContain(tc.id);
    expect(
      (await call(B, "GET", "/actions/unknown")).json.items.map(
        (x: any) => x.id,
      ),
    ).not.toContain(tc.id);
    expect(
      (
        await call(B, "POST", `/actions/${tc.id}/resolve`, {
          resolution: "done",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(A, "POST", `/actions/${tc.id}/resolve`, {
          resolution: "maybe",
        })
      ).status,
    ).toBe(400);
    const res = await call(A, "POST", `/actions/${tc.id}/resolve`, {
      resolution: "not_done",
      note: "Not in #general",
    });
    expect(res.status).toBe(200);
    expect(await used(A)).toBe(0); // a person confirmed it did not happen: slot returned
    expect(
      (
        await call(A, "POST", `/actions/${tc.id}/resolve`, {
          resolution: "done",
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(A, "GET", "/actions/unknown")).json.items.map(
        (x: any) => x.id,
      ),
    ).not.toContain(tc.id);
    const au = await asOrg(A, (q) =>
      q.one(
        `select action from audit_events where target_ref=$1 and action='action.resolved'`,
        [`tool_call:${tc.id}`],
      ),
    );
    expect(au).toBeTruthy();

    slackMode = "ok";
    const ok = await chatSlackPost(A);
    const tc2 = await asOrg(A, (q) =>
      q.one(
        `select status from tool_calls where run_id=$1 and tool='slack.post'`,
        [ok.runId],
      ),
    );
    expect(tc2.status).toBe("succeeded");
    expect(await used(A)).toBe(1);
  });

  it("cap reached under full autopilot → the action asks a human instead of running", async () => {
    expect(
      (
        await call(A, "PUT", `/workspaces/${A.ws}/autonomy`, {
          autonomy: "full",
          dailyExternalLimit: 1,
        })
      ).status,
    ).toBe(200);
    const before = posts;
    const { sse, runId } = await chatSlackPost(A);
    expect(sse).toContain("approval.required");
    expect(posts).toBe(before);
    const tc = await asOrg(A, (q) =>
      q.one(
        `select id, status from tool_calls where run_id=$1 and tool='slack.post'`,
        [runId],
      ),
    );
    expect(tc.status).toBe("waiting_approval");

    // Approving it while Slack times out → the approval reports "unknown", never "failed" or a silent retry.
    slackMode = "timeout";
    const ap = await asOrg(A, (q) =>
      q.one(`select id from approval_requests where tool_call_id=$1`, [tc.id]),
    );
    const dec = await call(A, "POST", `/approvals/${ap.id}/decision`, {
      decision: "approve",
    });
    expect(dec.status).toBe(200);
    expect(JSON.stringify(dec.json)).toContain("unknown");
    expect(
      (
        await asOrg(A, (q) =>
          q.one("select status from tool_calls where id=$1", [tc.id]),
        )
      ).status,
    ).toBe("unknown");
    expect(posts - before).toBe(1);
    slackMode = "ok";
  });

  it("reconciler: interrupted connected-app actions → unknown (slot kept); interrupted Qline-only actions → failed", async () => {
    expect(
      (
        await call(A, "PUT", `/workspaces/${A.ws}/autonomy`, {
          autonomy: "full",
          dailyExternalLimit: 10,
        })
      ).status,
    ).toBe(200);
    const ext = await plannedCall(A);
    expect(await reserve(A, ext)).toBe(true);
    const internal = await asOrg(A, (q) =>
      q.one<{ id: string }>(
        `insert into tool_calls (org_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,'tasks.create','{}','L1','allow',$2,'executing') returning id`,
        [A.org, `test:${randomUUID()}`],
      ),
    );
    const fresh = await plannedCall(A);
    await asOrg(A, (q) =>
      q.exec(
        `update tool_calls set created_at = now() - interval '20 minutes' where id = any($1)`,
        [[ext, internal!.id]],
      ),
    );
    const { reconcileStaleActions } = await import("../src/modules/actions");
    expect(await reconcileStaleActions()).toBeGreaterThanOrEqual(2);
    const st = async (id: string) =>
      (
        await asOrg(A, (q) =>
          q.one("select status from tool_calls where id=$1", [id]),
        )
      ).status;
    expect(await st(ext)).toBe("unknown");
    expect(await st(internal!.id)).toBe("failed");
    expect(await st(fresh)).toBe("executing"); // still within the window: left alone
    const r = await asOrg(A, (q) =>
      q.one(
        "select status from external_action_reservations where tool_call_id=$1",
        [ext],
      ),
    );
    expect(r.status).toBe("consumed");
    await asOrg(A, (q) =>
      q.exec(`update tool_calls set status='failed' where id=$1`, [fresh]),
    );
  });
});
