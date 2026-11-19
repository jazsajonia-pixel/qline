/**
 * Phase 4 (docs/21): several keys per provider (M10) and user-created agents (M9), against a real Postgres as the
 * app role (RLS enforced). Provider HTTP and the model are faked; no real provider is called.
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

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${who.token}`;
  if (who?.org) headers["x-qline-org"] = who.org;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

const asOrg = <T>(w: Who, fn: (q: import("../src/core/db").Q) => Promise<T>) => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);

async function setup(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, "POST", "/auth/sign-up/email", { email, password: "correct-horse-battery", name });
  expect(r.status).toBe(200);
  const w: Who = { token: r.json.token };
  w.org = (await call(w, "POST", "/orgs", { name: `${name} Co` })).json.id;
  w.userId = (await call(w, "GET", "/me")).json.user.id;
  w.ws = (await asOrg(w, (q) => q.one("select id from workspaces where org_id=$1", [w.org])))!.id;
  return w;
}

/** Runs one chat message to the end and returns the SSE text and run id. */
async function chat(w: Who, content: string, agentId?: string) {
  const conv = await call(w, "POST", "/conversations", agentId ? { agentId } : {});
  const m = await call(w, "POST", `/conversations/${conv.json.id}/messages`, { content });
  if (m.status !== 202) return { status: m.status, json: m.json, sse: "", runId: "" };
  const st = await app.fetch(new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, { headers: { authorization: `Bearer ${w.token}`, "x-qline-org": w.org! } }));
  return { status: 202, json: m.json, sse: await st.text(), runId: m.json.runId as string };
}

/** A model that fails with `fail` for the first `n` calls, then answers. */
function flaky(n: number, fail: "PROVIDER_RATE_LIMITED" | "PROVIDER_AUTH_FAILED") {
  let left = n;
  return {
    id: "flaky",
    capabilities: { tools: true, streaming: true, vision: false },
    calls: 0,
    async *stream() {
      this.calls++;
      if (left-- > 0) throw new ai.ProviderError(fail, fail === "PROVIDER_RATE_LIMITED" ? "429 Too Many Requests" : "401 invalid key", fail === "PROVIDER_RATE_LIMITED");
      yield { type: "token", text: "Hello." } as const;
      yield { type: "done" } as const;
    },
  };
}

d("Phase 4: key pool and custom agents", () => {
  const realFetch = globalThis.fetch;
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import("../src/index")).default as any;
    db = await import("../src/core/db");
    ai = await import("@qline/ai");
    // Provider key validation (listModels): accept keys starting with "sk-good", reject others.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!/\/models(\?|$)/.test(url)) return realFetch(input, init);
      const auth = String(init?.headers?.["x-api-key"] ?? init?.headers?.authorization ?? "");
      if (!auth.includes("sk-good")) return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
      return new Response(JSON.stringify({ data: [{ id: "claude-test-1", display_name: "Claude Test" }] }), { status: 200 });
    }) as typeof fetch;
    A = await setup("Amihan");
    B = await setup("Habagat");
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    ai.setTestProvider(null);
    await db.closePool();
  });

  it("adds several keys with distinct readable aliases, never returns secrets, isolates organizations", async () => {
    const k1 = await call(A, "POST", "/ai/providers/anthropic/keys", { apiKey: "sk-good-aaaaaaaaaaaa-1111" });
    expect(k1.status).toBe(201);
    expect(k1.json).toMatchObject({ alias: "Claude key 1", primary: true, state: "ready", keyHint: "1111" });
    const k2 = await call(A, "POST", "/ai/providers/anthropic/keys", { apiKey: "sk-good-bbbbbbbbbbbb-2222" });
    expect(k2.json).toMatchObject({ alias: "Claude key 2", primary: false });
    const k3 = await call(A, "POST", "/ai/providers/anthropic/keys", { apiKey: "sk-good-cccccccccccc-3333", alias: "Backup" });
    expect(k3.json.alias).toBe("Backup");
    expect((await call(A, "POST", "/ai/providers/anthropic/keys", { apiKey: "sk-good-aaaaaaaaaaaa-1111" })).json.code).toBe("AI_KEY_DUPLICATE");
    expect((await call(A, "POST", "/ai/providers/anthropic/keys", { apiKey: "sk-bad-dddddddddddddd" })).json.code).toBe("AI_KEY_REJECTED");
    expect((await call(A, "PATCH", `/ai/keys/${k2.json.id}`, { alias: "backup" })).json.code).toBe("AI_KEY_ALIAS_TAKEN");
    const ov = await call(A, "GET", "/ai/overview");
    const p = ov.json.providers.find((x: any) => x.id === "anthropic");
    expect(p.connected).toBe(true);
    expect(p.keys.map((k: any) => k.alias)).toEqual(["Claude key 1", "Claude key 2", "Backup"]);
    const raw = JSON.stringify(ov.json) + JSON.stringify((await call(A, "GET", "/ai/providers/anthropic/keys")).json);
    for (const s of ["sk-good-aaaaaaaaaaaa", "sk-good-bbbbbbbbbbbb", "key_ciphertext"]) expect(raw).not.toContain(s);
    // Another organization sees none of them and cannot touch them.
    expect((await call(B, "GET", "/ai/providers/anthropic/keys")).json.items).toEqual([]);
    expect((await call(B, "PATCH", `/ai/keys/${k2.json.id}`, { enabled: false })).status).toBe(404);
    expect((await call(B, "DELETE", `/ai/keys/${k2.json.id}`)).status).toBe(404);
    expect((await call(A, "PUT", "/ai/default", { provider: "anthropic", model: "claude-test-1" })).status).toBe(200);
  });

  it("routes least-recently-used, records the alias per run, and fails over once on a rate limit", async () => {
    ai.setTestProvider(new ai.MockProvider(() => [{ type: "token", text: "Hi." }, { type: "done" }]));
    const used = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await chat(A, `hello ${i}`);
      expect(r.sse).toContain("event: done");
      used.add((await asOrg(A, (q) => q.one("select key_id from agent_runs where id=$1", [r.runId])))!.key_id);
    }
    expect(used.size).toBe(3); // three keys, three runs: each used once

    const fl = flaky(1, "PROVIDER_RATE_LIMITED");
    ai.setTestProvider(fl as any);
    const r = await chat(A, "hello again");
    expect(r.sse).toContain("Hello.");
    expect(r.sse).toContain("Switched to another key");
    expect(fl.calls).toBe(2);
    const keys = await asOrg(A, (q) => q.many("select alias, rate_limited, cooldown_until from ai_keys where org_id=$1 order by alias", [A.org]));
    const limited = keys.filter((k: any) => Number(k.rate_limited) === 1);
    expect(limited.length).toBe(1);
    expect(new Date(limited[0].cooldown_until).getTime()).toBeGreaterThan(Date.now() + 50_000);
    // The cooling key is skipped by the next picks.
    ai.setTestProvider(new ai.MockProvider(() => [{ type: "token", text: "Hi." }, { type: "done" }]));
    for (let i = 0; i < 2; i++) {
      const x = await chat(A, `more ${i}`);
      const k = await asOrg(A, (q) => q.one("select k.alias from agent_runs r join ai_keys k on k.id=r.key_id where r.id=$1", [x.runId]));
      expect(k!.alias).not.toBe(limited[0].alias);
    }
    const ov = await call(A, "GET", "/ai/overview");
    expect(ov.json.providers.find((x: any) => x.id === "anthropic").keys.find((k: any) => k.alias === limited[0].alias).state).toBe("cooling_down");
  });

  it("a rejected key is marked as needing attention and not retried; a pinned agent gets a clear error instead of another key", async () => {
    const list = (await call(A, "GET", "/ai/providers/anthropic/keys")).json.items;
    // reset cooldowns so the outcome is deterministic
    await asOrg(A, (q) => q.exec("update ai_keys set cooldown_until=null, consecutive_limits=0 where org_id=$1", [A.org]));
    const fl = flaky(1, "PROVIDER_AUTH_FAILED");
    ai.setTestProvider(fl as any);
    const r = await chat(A, "auth check");
    expect(r.sse).toContain("Hello.");
    const bad = await asOrg(A, (q) => q.many("select id, alias from ai_keys where org_id=$1 and status='invalid'", [A.org]));
    expect(bad.length).toBe(1);

    // Pin the CEO to the rejected key: the run fails with a message naming the key, no silent switch.
    const ceo = (await call(A, "GET", "/agents")).json.items.find((a: any) => a.template === "ceo");
    const pin = await call(A, "PUT", `/agents/${ceo.id}/model`, { provider: "anthropic", model: "claude-test-1", keyId: bad[0].id });
    expect(pin.status).toBe(200);
    ai.setTestProvider(new ai.MockProvider(() => [{ type: "token", text: "Hi." }, { type: "done" }]));
    const p = await chat(A, "pinned");
    expect(p.sse).toContain("AI_KEY_UNAVAILABLE");
    expect(p.sse).toContain(bad[0].alias);
    // Re-enabling clears "needs attention"; the pinned agent then uses exactly that key.
    expect((await call(A, "PATCH", `/ai/keys/${bad[0].id}`, { enabled: true })).json.state).toBe("ready");
    const ok = await chat(A, "pinned again");
    expect(ok.sse).toContain("event: done");
    expect((await asOrg(A, (q) => q.one("select key_id from agent_runs where id=$1", [ok.runId])))!.key_id).toBe(bad[0].id);
    // Wrong provider assignment is refused.
    const other = list.find((k: any) => k.id !== bad[0].id);
    expect((await call(A, "PUT", `/agents/${ceo.id}/model`, { provider: null, keyId: other.id })).status).toBe(400);
    // Deleting the pinned key unpins the agent (new version) and promotes a new primary if needed.
    const del = await call(A, "DELETE", `/ai/keys/${bad[0].id}`);
    expect(del.json.unpinnedAgents).toBe(1);
    const after = (await call(A, "GET", `/agents/${ceo.id}`)).json;
    expect(after.key_id).toBeNull();
    const prim = await asOrg(A, (q) => q.many("select alias from ai_keys where org_id=$1 and is_primary", [A.org]));
    expect(prim.length).toBe(1);
    // The legacy single-key row (read by older app versions and voice) still decrypts to the primary key.
    const { loadKey } = await import("../src/agent/models");
    expect(await asOrg(A, (q) => loadKey(q, A.org!, "anthropic"))).toMatch(/^sk-good-/);
  });

  it("custom agents: created paused with read-only tools, entitlement-bounded, versioned, revertible, archivable", async () => {
    const c1 = await call(A, "POST", "/agents", { name: "Study buddy", description: "Helps me revise", icon: "school", accent: "mint", instructions: "Quiz me on my notes." });
    expect(c1.status).toBe(201);
    expect(c1.json).toMatchObject({ template: "custom", status: "paused", based_on: "research", accent: "mint" });
    const detail = (await call(A, "GET", `/agents/${c1.json.id}`)).json;
    const { TOOL_POLICIES } = await import("@qline/policy");
    expect(detail.tool_allowlist.length).toBeGreaterThan(0);
    expect(detail.tool_allowlist.every((t: string) => TOOL_POLICIES[t]!.risk === "L0")).toBe(true);
    // A tool outside its profile is refused, at creation and later.
    const outside = Object.entries(TOOL_POLICIES).find(([, p]) => !p.templates.includes("research"))![0];
    expect((await call(A, "POST", "/agents", { name: "Sneaky", instructions: "x", toolAllowlist: [outside] })).status).toBe(403);
    expect((await call(A, "PATCH", `/agents/${c1.json.id}`, { toolAllowlist: [outside] })).status).toBe(403);
    // Edits are versions; revert restores as a new version.
    expect((await call(A, "PATCH", `/agents/${c1.json.id}`, { instructions: "Be strict.", approvalMode: "ask_all", maxToolCalls: 3 })).status).toBe(200);
    const v2 = (await call(A, "GET", `/agents/${c1.json.id}`)).json;
    expect(v2).toMatchObject({ current_version: 2, instructions: "Be strict.", approval_mode: "ask_all", max_tool_calls: 3 });
    const rv = await call(A, "POST", `/agents/${c1.json.id}/revert`, { version: 1 });
    expect(rv.json).toMatchObject({ version: 3, restored: 1 });
    const v3 = (await call(A, "GET", `/agents/${c1.json.id}`)).json;
    expect(v3).toMatchObject({ instructions: "Quiz me on my notes.", approval_mode: "policy", max_tool_calls: 8 });
    expect(v3.versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
    // Clone of a built-in keeps its profile and tools; two custom agents can coexist.
    const sales = (await call(A, "GET", "/agents")).json.items.find((a: any) => a.template === "sales");
    const c2 = await call(A, "POST", "/agents", { name: "My sales copy", cloneFrom: sales.id });
    expect(c2.json).toMatchObject({ template: "custom", based_on: "sales", status: "paused" });
    expect((await call(A, "GET", `/agents/${c2.json.id}`)).json.tool_allowlist.sort()).toEqual([...sales.tool_allowlist].sort());
    // Paused: chat refuses. Preview works without tools and saves nothing.
    ai.setTestProvider(new ai.MockProvider((req) => [{ type: "token", text: `tools:${req.tools ? req.tools.length : 0}` }, { type: "done" }]));
    const before = (await asOrg(A, (q) => q.one("select count(*)::int as n from conversation_messages where org_id=$1", [A.org])))!.n;
    const pv = await call(A, "POST", `/agents/${c1.json.id}/preview`, { message: "Ask me one question" });
    expect(pv.json).toMatchObject({ ok: true, reply: "tools:0" });
    expect((await asOrg(A, (q) => q.one("select count(*)::int as n from conversation_messages where org_id=$1", [A.org])))!.n).toBe(before);
    // Other org cannot see, edit or preview it.
    expect((await call(B, "GET", `/agents/${c1.json.id}`)).status).toBe(404);
    expect((await call(B, "PATCH", `/agents/${c1.json.id}`, { status: "active" })).status).toBe(404);
    expect((await call(B, "POST", `/agents/${c1.json.id}/preview`, { message: "hi" })).status).toBe(404);
    // Built-ins cannot be archived; custom ones can, and disappear from the list.
    expect((await call(A, "DELETE", `/agents/${sales.id}`)).json.code).toBe("AGENT_BUILT_IN");
    expect((await call(A, "DELETE", `/agents/${c2.json.id}`)).status).toBe(200);
    expect((await call(A, "GET", "/agents")).json.items.some((a: any) => a.id === c2.json.id)).toBe(false);
    expect((await call(A, "PATCH", `/agents/${c2.json.id}`, { status: "active" })).status).toBe(404);
  });

  it("budgets: daily answer limit and per-run tool cap; ask-all approval mode parks writes", async () => {
    const c = await call(A, "POST", "/agents", { name: "Limited", instructions: "Help.", basedOn: "operations", dailyRuns: 1, maxToolCalls: 0 });
    expect(c.status).toBe(201);
    await call(A, "PATCH", `/agents/${c.json.id}`, { status: "active" });
    ai.setTestProvider(new ai.MockProvider((req) => [{ type: "token", text: `tools:${req.tools ? req.tools.length : 0}` }, { type: "done" }]));
    const first = await chat(A, "one", c.json.id);
    expect(first.sse).toContain("tools:0"); // maxToolCalls 0: no tools offered
    const second = await chat(A, "two", c.json.id);
    expect(second.status).toBe(429);
    expect(second.json.code).toBe("AGENT_BUDGET_REACHED");

    const { decideTool } = await import("@qline/policy");
    const base = { tool: "tasks.create", allowlist: ["tasks.create", "tasks.search"], userRole: "owner" as const, autonomy: "autopilot" as const };
    expect(decideTool(base).decision).toBe("allow");
    expect(decideTool({ ...base, askAll: true }).decision).toBe("require_approval");
    expect(decideTool({ ...base, tool: "tasks.search", askAll: true }).decision).toBe("allow");
  });
});
