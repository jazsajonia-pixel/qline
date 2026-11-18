/**
 * M1 remainder: OAuth refresh is single-flight and only a dead grant ends a connection.
 * Real Postgres as the app role (RLS enforced). Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = "test";
process.env.QLINE_RUNTIME_KICK = "0";
process.env.QLINE_MICROSOFT_CLIENT_ID = "test-client";
process.env.QLINE_MICROSOFT_CLIENT_SECRET = "test-secret";

const d = envFile ? describe : describe.skip;
const realFetch = globalThis.fetch;

let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import("../src/core/db");
let O: typeof import("../src/integrations/oauth");
let who: { token: string; org: string; userId: string; ws: string };

async function call(method: string, path: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = {};
  if (auth) {
    headers.authorization = `Bearer ${who.token}`;
    if (who.org) headers["x-qline-org"] = who.org;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: await res.json().catch(() => null) };
}

const asOrg = <T>(fn: (q: import("../src/core/db").Q) => Promise<T>) => db.withTenant({ orgId: who.org, userId: who.userId }, fn);

/** Token endpoint stub: counts calls, answers slowly so concurrent refreshes overlap, rotates refresh tokens. */
let tokenCalls = 0;
let answer: () => Response = () => new Response("{}");
function stubTokenEndpoint() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("https://login.microsoftonline.com/")) {
      tokenCalls++;
      await new Promise((r) => setTimeout(r, 150));
      return answer();
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

async function connect(expired: boolean) {
  await asOrg((q) => q.exec(`delete from integration_connections where provider='microsoft'`));
  const sealed = O.sealTokens(who.org, "microsoft", { access_token: "old-access", refresh_token: "rt-1", expires_at: expired ? Date.now() - 1000 : Date.now() + 3_600_000 });
  return (await asOrg((q) =>
    q.one<{ id: string }>(
      `insert into integration_connections (org_id, workspace_id, provider, status, connected_by, token_ciphertext, settings) values ($1,$2,'microsoft','ok',$3,$4,'{}') returning id`,
      [who.org, who.ws, who.userId, sealed],
    ),
  ))!.id;
}
const load = (id: string) => asOrg((q) => q.one("select * from integration_connections where id=$1", [id]));

d("OAuth refresh (M1 remainder)", () => {
  beforeAll(async () => {
    app = (await import("../src/index")).default as any;
    db = await import("../src/core/db");
    O = await import("../src/integrations/oauth");
    const email = `refresh-${randomUUID().slice(0, 8)}@test.qline.dev`;
    const r = await call("POST", "/auth/sign-up/email", { email, password: "correct-horse-battery", name: "Refresh" }, false);
    who = { token: r.json.token, org: "", userId: "", ws: "" };
    who.org = (await call("POST", "/orgs", { name: "Refresh Co" })).json.id;
    who.userId = (await call("GET", "/me")).json.user.id;
    who.ws = (await asOrg((q) => q.one("select id from workspaces where org_id=$1", [who.org])))!.id;
    stubTokenEndpoint();
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.closePool();
  });

  it("five concurrent callers with an expired token cause exactly one refresh and all get the new token", async () => {
    const id = await connect(true);
    tokenCalls = 0;
    let n = 0;
    answer = () => new Response(JSON.stringify({ access_token: `new-access-${++n}`, refresh_token: `rt-${n + 1}`, expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    const rows = await Promise.all(Array.from({ length: 5 }, () => load(id)));
    const tokens = await Promise.all(rows.map((row) => asOrg((q) => O.accessToken(q, row))));
    expect(tokenCalls).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["new-access-1"]));
    const after = await load(id);
    const t = JSON.parse((await import("../src/core/secrets")).open(after.token_ciphertext, `oauth:${who.org}:microsoft`));
    expect(t.refresh_token).toBe("rt-2"); // the rotated refresh token was kept
  });

  it("a timeout or 5xx leaves the connection usable; only invalid_grant marks it expired", async () => {
    const id = await connect(true);
    answer = () => new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 });
    await expect(asOrg(async (q) => O.accessToken(q, await load(id)))).rejects.toBeInstanceOf(O.TokenRefreshUnavailable);
    expect((await load(id)).status).toBe("ok");

    answer = () => {
      throw new TypeError("fetch failed");
    };
    await expect(asOrg(async (q) => O.accessToken(q, await load(id)))).rejects.toBeInstanceOf(O.TokenRefreshUnavailable);
    expect((await load(id)).status).toBe("ok");

    answer = () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), { status: 400 });
    await expect(asOrg(async (q) => O.accessToken(q, await load(id)))).rejects.toBeInstanceOf(O.ConnectionExpired);
    expect((await load(id)).status).toBe("expired");
  });

  it("a fresh token is used without calling the provider", async () => {
    const id = await connect(false);
    tokenCalls = 0;
    expect(await asOrg(async (q) => O.accessToken(q, await load(id)))).toBe("old-access");
    expect(tokenCalls).toBe(0);
  });
});
