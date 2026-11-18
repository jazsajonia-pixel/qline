/**
 * Personal AI OS build (docs/21) against a real Postgres as the app role (RLS enforced).
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = "test";
process.env.QLINE_RUNTIME_KICK = "0";

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string; email?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import("../src/core/db");

async function call(who: Who | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
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

async function signUp(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, "POST", "/auth/sign-up/email", { email, password: "correct-horse-battery", name });
  expect(r.status).toBe(200);
  const w: Who = { token: r.json.token, email };
  w.userId = (await call(w, "GET", "/me")).json.user.id;
  return w;
}

async function withOrg(w: Who, name = `${w.email} Co`) {
  w.org = (await call(w, "POST", "/orgs", { name })).json.id;
  w.ws = (await db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => q.one("select id from workspaces where org_id=$1", [w.org])))!.id;
  return w;
}

d("Personal AI OS", () => {
  beforeAll(async () => {
    app = (await import("../src/index")).default as any;
    db = await import("../src/core/db");
  });
  afterAll(async () => {
    await db.closePool();
  });

  describe("sessions (phase 2)", () => {
    it("lists sessions without tokens and signs out every other device", async () => {
      const a = await signUp("Lakan");
      const second = await call(null, "POST", "/auth/sign-in/email", { email: a.email, password: "correct-horse-battery" });
      expect(second.status).toBe(200);
      const b: Who = { token: second.json.token };
      const list = await call(a, "GET", "/me/sessions");
      expect(list.json.items.length).toBe(2);
      expect(JSON.stringify(list.json)).not.toContain(a.token);
      expect(list.json.items.filter((x: any) => x.current).length).toBe(1);
      const r = await call(a, "POST", "/me/sessions/revoke-others");
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ revoked: 1, remaining: 1 });
      expect((await call(b, "GET", "/me")).status).toBe(401);
      expect((await call(a, "GET", "/me")).status).toBe(200);
    });
  });
});

export { call, signUp, withOrg };
