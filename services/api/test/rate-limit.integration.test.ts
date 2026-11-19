/** Phase 2: sign-in rate limits are kept in Postgres ("rateLimit", 0015), so they hold across instances. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = "test";
process.env.QLINE_RUNTIME_KICK = "0";
process.env.QLINE_RATE_LIMIT_STORAGE = "database";

const d = envFile ? describe : describe.skip;
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import("../src/core/db");

d("database rate limit", () => {
  beforeAll(async () => {
    app = (await import("../src/index")).default as any;
    db = await import("../src/core/db");
  });
  afterAll(() => db.closePool());

  it("blocks the 11th wrong password from one IP within 5 minutes and stores the counter in Postgres", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const email = `rl-${randomUUID().slice(0, 8)}@test.qline.dev`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await app.fetch(
        new Request("http://localhost/v1/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ email, password: "wrong-password-123" }),
        }),
      );
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const row = await db.withTenant({ orgId: null, userId: "test" }, (q) => q.one(`select count from "rateLimit" where key like $1`, [`%${ip}%`]));
    expect(Number(row?.count)).toBeGreaterThanOrEqual(10);
  });
});
