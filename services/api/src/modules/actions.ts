import { Hono } from "hono";
import { z } from "zod";
import {
  canDecideApproval,
  EXTERNAL_WRITE_TOOLS,
  type Risk,
} from "@qline/policy";
import { audit } from "../core/audit";
import { need, tx, type Env } from "../core/context";
import { withTenant } from "../core/db";
import { ApiError, forbidden, notFound } from "../core/errors";
import { body } from "../core/validate";

/**
 * M1 (docs/17 §B): actions in connected apps whose outcome Qline could not confirm.
 * They are never retried automatically. A person checks the connected app and records what really happened.
 */
export const actionRoutes = new Hono<Env>();

/** Past every provider timeout (20 s) and job lease, an action still "executing" was interrupted. */
export const STALE_EXECUTING_MINUTES = 15;

/** Scheduler tick: interrupted connected-app actions become "unknown" (slot stays used); Qline-only ones "failed". */
export async function reconcileStaleActions(): Promise<number> {
  const rows = await withTenant(
    { orgId: null, userId: "system:reconciler" },
    (q) =>
      q.many("select * from qline_mark_stale_executing($1, $2)", [
        STALE_EXECUTING_MINUTES,
        [...EXTERNAL_WRITE_TOOLS],
      ]),
  );
  return rows.length;
}

actionRoutes.get("/actions/unknown", async (c) => {
  const t = need(c, "tasks.read");
  const items = await tx(t, (q) =>
    q.many(
      `select id, tool, risk, result_summary as summary, created_at, finished_at, run_id, workflow_run_id, mission_task_id
         from tool_calls where status='unknown' and resolution is null order by created_at desc limit 100`,
    ),
  );
  return c.json({ items });
});

actionRoutes.post("/actions/:id/resolve", async (c) => {
  const t = need(c, "tasks.read");
  const b = await body(
    c,
    z.object({
      resolution: z.enum(["done", "not_done"]),
      note: z.string().trim().max(1000).optional(),
    }),
  );
  const out = await tx(t, async (q) => {
    const tc = await q.one(
      "select id, tool, risk, status, resolution from tool_calls where id=$1 for update",
      [c.req.param("id")],
    );
    if (!tc) throw notFound("Action");
    if (!canDecideApproval(t.role, tc.risk as Risk))
      throw forbidden(`Your role cannot resolve ${tc.risk} actions.`);
    if (tc.status !== "unknown" || tc.resolution)
      throw new ApiError(
        409,
        "NOT_UNKNOWN",
        "Nothing to resolve",
        "This action is not waiting for a check.",
      );
    await q.exec(
      `update tool_calls set resolution=$2, resolution_note=$3, resolved_by=$4, resolved_at=now() where id=$1`,
      [tc.id, b.resolution, b.note ?? null, t.userId],
    );
    // A person confirmed it did not happen: give the full-autopilot slot back.
    if (b.resolution === "not_done")
      await q.exec(
        `update external_action_reservations set status='released', settled_at=now() where tool_call_id=$1 and status <> 'released'`,
        [tc.id],
      );
    await audit(q, {
      orgId: t.orgId,
      actorKind: "user",
      actorId: t.userId,
      action: "action.resolved",
      targetRef: `tool_call:${tc.id}`,
      correlationId: t.correlationId,
      detail: { tool: tc.tool, resolution: b.resolution },
    });
    return { id: tc.id, status: "unknown", resolution: b.resolution };
  });
  return c.json(out);
});
