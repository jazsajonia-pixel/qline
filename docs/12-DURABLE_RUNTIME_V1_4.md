# 12 — Architecture spike and v1.4 Durable Automation Runtime

Status: **spike done, design proposed, M1–M3 implemented on `feat/v1.4-durable-runtime` (not merged, not deployed to production).**
Date: 2026-11-17. Product direction (Sapphire Decisions Log, 2026-11-17): Full AI Business Operating System, supervised execution, parallel and sequential agent collaboration.

## 1. Question

Qline needs (v1.4) durable background execution and (v1.5) an AI CEO that delegates to specialist agents in parallel and in sequence. Which orchestration harness should we use, LangGraph.js, Mastra or a Qline-owned core, and what worker topology works on the current free Neon Functions setup without paid infrastructure?

## 2. Constraints from the current system (inspected, `main` 766768a)

| Area | Today | Gap |
| --- | --- | --- |
| Hosting | One Neon Function (`api`, Hono, Node 24) and one Neon cron trigger `*/15 * * * *` calling `/internal/tick/:key` | No always-on process. Neon says functions "aren't a job queue" ([Neon Functions](https://neon.com/docs/compute/functions/overview)). |
| Runtime limits | 15 min time-to-first-byte, `waitUntil` up to 15 min, eviction with `SIGINT` then a hard stop 5 s later, in-memory state lost ([runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits)) | Any work that lives only in memory can be lost. |
| Trigger delivery | Cron can run every minute; deliveries are retried for up to 72 h, "can happen more than once" and out of order ([Function Triggers](https://neon.com/docs/compute/functions/triggers/overview), [schedules](https://neon.com/docs/compute/functions/triggers/schedule)) | The tick must be idempotent. |
| Free-plan budget | 10 active / 400 waiting Capacity-Hours and 1M invocations per project per month ([Neon plans](https://neon.com/docs/introduction/plans)) | A worker that idles for 50 s every minute would use about 600 waiting hours, so ticks must stop as soon as the queue is empty. |
| Events | `core/events.ts` calls one in-process handler **after** commit and swallows errors | Events are lost if the process dies or the handler throws. |
| Workflows | `startWorkflowRun` runs every step inline in the HTTP request or tick | No retry, no recovery. External HTTP calls (AI, Gmail, Slack) run inside a DB transaction that holds a row lock. |
| Approvals | The decision commits, then the run resumes in a second call | If the process dies between the two, an approved run stays in `waiting_approval` forever. |
| Schedules | The tick computes due workflows and runs them synchronously | One slow run delays the rest. A crash means the day's run is skipped (`last_scheduled_at` was already set). |
| Fresh database | `0006` granted to `qline_app` before `9999_app_role` creates it | A clean database could not migrate. **Fixed** in this branch (guarded grant, same effect in production). |

## 3. Harness spike (real code, local Postgres 18, same scenario for each)

Scenario: supervisor → two specialists **in parallel** (one fails once) → review → **approval gate** → one side effect. Tests: retry only the failed branch; resume after a crash on a fresh instance; a rejected approval cannot be bypassed; two concurrent approvals cause one side effect; can tenant data be protected by RLS?

The agents are deterministic stubs, so the spike tests orchestration semantics, not model quality. Spike code lives outside the repo (`/tmp/spike/{lg,ma}`), and the numbers below are from those runs.

| Check | LangGraph.js 1.7.5 + PostgresSaver 1.1.4 (MIT) | Mastra core 1.83.0 + @mastra/pg 1.36.0 (Apache-2.0, `ee/` dirs under a separate licence) | Qline core (this branch) |
| --- | --- | --- | --- |
| Parallel fan-out / fan-in | `Send` + reducer: works | `.parallel([a,b])`: works | Planned for v1.5 on job groups (§6) |
| Retry only the failed branch | Yes: `invoke(null)` re-ran 1 of 2 branches | Not with `restart()` (failed runs stay failed). Possible with `timeTravel({step})`, but you must name the step yourself | Yes (job retry with backoff) |
| Resume after a crash on a new instance | Yes, 0 specialists re-ran | Manual (timeTravel) | Yes (lease expiry → reclaim), tested |
| Rejected approval cannot be bypassed | Yes (resume/approve after reject ran nothing) | Yes ("not suspended") | Yes, tested |
| Two concurrent approvals | **Ran the side-effect node twice.** Only our idempotency key kept the effect single | Atomic claim: second caller rejected | Approval row lock + job idempotency key, tested |
| Tenant isolation | Checkpoint tables have no tenant column, so RLS is impossible. Isolation relies on thread-id naming | 41 `mastra_*` tables in `public`; `resourceId` but no RLS | `org_id` + RLS on every runtime table |
| Durable worker / queue on Neon | **None.** Something must call `invoke` | Durable agents need "fencing-capable shared storage … plus shared pubsub/lease infrastructure" ([Mastra 1.82 release](https://github.com/mastra-ai/mastra/releases/tag/@mastra/core@1.82.0)) | Postgres queue drained by cron ticks + `waitUntil` |
| Model / BYOK layer | Its own model abstractions (`@langchain/core`) | Vercel AI SDK model router | Existing `@qline/ai` (5 providers, no silent fallback) |
| Bundle added (minified) | +1.4 MB | +7.3 MB (current API bundle 6.0 MB) | ~0 |

Takeaways:
1. **Neither harness gives Qline the v1.4 durable execution layer on Neon.** Both need an external driver, which means a queue. We have to build or buy that layer whichever harness wins.
2. Both are good at in-graph state and human pauses, but both bring their own model layer, tables and execution semantics. Wiring BYOK, L0–L4 policy and tenant RLS through them costs more than the orchestration they save at Qline's current size.
3. pg-boss (v12, MIT) is the credible "buy" option for the queue: retries, DLQ, cron, a serverless-friendly `fetch`/`complete` ([pg-boss](https://pgboss.io/introduction)). It loses on fit, not quality. It runs in its own schema without tenant RLS, it assumes a long-lived instance for supervision/maintenance, and it can't take part in our tenant transactions under the least-privilege `qline_app` role without broad grants. It remains the fallback if the in-house queue grows past ~1k lines or misses a release gate.

## 4. Verdict (Independent Judgment Policy)

**Verdict: APPROVE WITH CONDITIONS.** Build a **Qline-owned durable runtime on Postgres** for v1.4, and a **Qline-owned supervisor core** on top of it for v1.5. Re-evaluate LangGraph.js only for complex in-run agent graphs, behind our policy and BYOK boundary.

- **Reasoning:** the durable layer is required whatever harness we pick (spike, §3). Owning it keeps tenant RLS, audit, approvals and idempotency inside the same Postgres transactions we already trust, with no new paid infrastructure.
- **Problems and trade-offs:** we own the correctness of the queue (mitigated by real-Postgres tests of every release gate). Latency is limited by tick frequency for work that isn't kicked by a request (§5). No graph visualiser or time-travel debugger.
- **Conditions:**
  1. The runtime stays small, and every release gate in §8 has a real-Postgres test.
  2. Consequential external actions are at-most-once with an "outcome unknown → human review" path, never blind retries.
  3. No harness is adopted without a re-run of this spike against the v1.5 scenario.
- **Better approach considered:** pg-boss for the queue (§3.3). Rejected for fit, kept as the fallback.

## 5. Worker topology (free Neon)

```
API request ──(same tx)──► business rows + outbox_events / jobs
     │                                   ▲
     └─ waitUntil(drain(budget 20 s)) ───┤      "kick": fast path, best effort
Neon cron tick ─► /internal/tick ────────┘      relay outbox → jobs, enqueue schedules/syncs,
                                                 reclaim expired leases, drain(budget 45 s)
```

- **Independent workers:** every tick and every kick is a worker with its own id (`fn:<random>`). Claims use `FOR UPDATE SKIP LOCKED`, so any number can run at once without double work.
- **Recovery is driven by leases, not processes.** A job a dying worker held becomes claimable when `lease_until` passes. The next tick reclaims it.
- **Drain stops when the queue is empty** (no idle polling), so idle ticks cost about one short invocation.
- **Tick frequency** stays at 15 min in production until Jazz approves a change. **Recommended: `*/5 * * * *`** (8,640 invocations/month, about 1% of the free allowance). This bounds retry/backoff and recovery latency to about 5 min. Request-triggered work starts immediately through the kick either way.

## 6. Data model (migration `0007_durable_runtime.sql`)

- **`jobs`**: `id, org_id (null = system), kind, payload, status (queued|running|succeeded|failed|dead|cancelled), priority, run_at, attempts, max_attempts, lease_owner, lease_until, heartbeat_at, idempotency_key, parent_id, group_id, cancel_requested, deadline_at, last_error, result, created_by, timestamps`.
  - Unique on `(coalesce(org_id, zero-uuid), kind, idempotency_key)`, so enqueueing the same logical job twice is a no-op.
  - RLS `tenant_isolation`. The app role sees only its org's jobs.
- **`job_attempts`**: one row per attempt (worker, start/end, outcome, error). This is the retry history.
- **`outbox_events`**: `org_id, workspace_id, type, event_key, data, actor, created_at, relayed_at`.
  - Unique on `(org_id, event_key)`, so a re-emitted event is deduplicated.
  - Written in the **same transaction** as the business change.
- **Status `dead`** acts as the dead-letter queue. Owners/admins can list, retry or cancel dead jobs.
- **Cross-tenant operations** are `SECURITY DEFINER` functions that return only ids and lease data: `qline_claim_jobs`, `qline_job_heartbeat`, `qline_job_finish`, `qline_relay_outbox`. Same pattern as `qline_due_schedules`. Handlers then run under the job's tenant context with RLS on.
- **Fencing:** finish and heartbeat need `(job_id, lease_owner, attempts)` to match. A worker whose lease expired and was reclaimed can't overwrite the newer attempt's result.
- **Workflow runs** gain the statuses `queued`, `cancelled` and `needs_attention`. External step intents are recorded in `tool_calls` (new status `executing`).

## 7. Semantics

| Concern | Rule |
| --- | --- |
| Enqueue | `enqueue(q, …)` inside the caller's transaction, so the job exists if and only if the business change committed. |
| Claim | Highest priority, then oldest `run_at`, with `SKIP LOCKED`. Also reclaims `running` jobs whose lease has expired. Sets `attempts+1` and the lease. |
| Lease / heartbeat | Default lease 60 s. Handlers heartbeat between steps. The heartbeat returns `cancel_requested`. |
| Retries | Thrown errors retry with exponential backoff and jitter: `min(5 s·2^(n-1), 15 min)`. `PermanentError` → `failed` with no retry. After `max_attempts` → `dead` (and the owner is notified for workflow jobs). |
| Idempotency | Job identity via `idempotency_key`. Side effects keyed by **stable** keys (`wf:<run>:<step>`), never by attempt. |
| DB-local tools | Run inside the step transaction with the `tool_calls` unique key: exactly-once. |
| External actions (email, Slack, calendar) | Record a `tool_calls` intent (`executing`) and **commit**, then call the provider, then record the result. If a retry finds an `executing` intent, the outcome is unknown: the step is **not** re-sent, and the run moves to `needs_attention` for a human. At-most-once. |
| AI steps | No external side effect, so they're retried within `max_attempts` (spend bounded by attempts). |
| Approvals | The decision transaction also enqueues `workflow.resume` (atomic). Expired or rejected approvals never enqueue. Resume re-checks `status='waiting_approval'`. Retries and delegation can't skip an approval step, because each step's gate is re-evaluated from the run row. |
| Cancellation | Queued jobs → `cancelled` immediately. Running jobs see `cancel_requested` at the next heartbeat or step boundary. Workflow-run cancel marks the run `cancelled` and cancels its jobs. Steps already committed stay done (no compensation in v1.4). |
| Schedules | The tick enqueues `workflow.scheduled` jobs keyed `schedule:<wf>:<day>`. Duplicate trigger deliveries and overlapping ticks can't start a second run. A crash before the run starts is retried. |
| Events | The relay turns outbox rows into one `event.dispatch` job per event (key = event id). That job starts the matching workflow runs, deduplicated by `(workflow_id, dedupe_key)`. |
| Tenant isolation | Every runtime row has `org_id` + RLS. Workers run handlers with the job's `org_id`, and a handler can't read or enqueue for another org (RLS `with check`). |
| Emergency stop | `QLINE_RUNTIME_PAUSED=1` (env) stops all claiming. Per-org pause is planned for v1.5. |

## 8. Release gates (from Sapphire, mapped to tests)

| Gate | Test (`services/api/test/runtime.integration.test.ts`) |
| --- | --- |
| No job lost on disconnect | Lease expiry → another worker reclaims and finishes |
| Duplicate delivery can't duplicate a side effect | Same idempotency key enqueued twice; double tick; stale worker fenced |
| Cross-tenant isolation at the job layer | Org B can't see, cancel or retry org A's jobs; handler context is org A only |
| Denied/expired approvals can't be bypassed via retries | Reject → no resume job; retrying a dead resume job can't run a rejected step |
| Retries, backoff, DLQ | Transient → retried with `run_at` in the future; permanent → failed; exhausted → dead |
| Cancellation | Queued and running jobs; workflow-run cancel |
| Event/schedule activation, restart recovery | Outbox relay → event job → workflow run; schedule keyed once per day |
| External step at-most-once | `executing` intent found on retry → `needs_attention`, provider not called again |
| Concurrency and spend limits, every agent action recorded with mission/run refs, handoffs, parallel aggregation, emergency stop E2E | **v1.5** (only the global pause switch exists in v1.4) |

## 9. Milestones

| # | Scope | Status |
| --- | --- | --- |
| M0 | Spike + this design | Done |
| M1 | `0007` schema, runtime core (enqueue/claim/heartbeat/finish/retry/DLQ/cancel), worker drain, tests | Implemented + verified locally (§11) |
| M2 | Transactional outbox; events through the relay; approval decision enqueues resume atomically | Implemented + verified locally (§11) |
| M3 | Workflow runs, schedules, syncs on jobs; external-step intent ledger; cancel endpoint; ops endpoints; tick + kick | Implemented + verified locally (§11); not yet on Neon |
| M4 | Deploy to a Neon **preview branch**, verify trigger + kick end to end; then production after approval; cron to `*/5` after approval | Needs Jazz |
| M5 | App: run status `queued`/`needs_attention`/`cancelled`, cancel button, failed-jobs view | Not started |

## 10. v1.5 preparation (design only, nothing built)

- **Mission → task graph.** `missions(id, org_id, goal, owner, status, budget_tokens, budget_spend, deadline)` and `mission_tasks(id, mission_id, agent_id, depends_on[], input, output, review_status)`. Each task is a `jobs` row of kind `agent.task`.
- **Parallel** = tasks with no unmet dependency share a `group_id`. **Fan-in** = a `mission.review` job enqueued when the last job in the group finishes (counter row updated inside `finish`).
- **Sequential handoff** = `depends_on`. The supervisor (AI CEO) only proposes tasks. A policy check turns the proposal into jobs.
- **Delegation is a permission intersection:** child agent scopes ⊆ parent scopes ∩ the requesting human's role (07 §3). An approval gate inherited from a parent can't be dropped.
- **Structured result review:** each task returns `{status, summary, evidence_refs[], confidence}` validated by Zod. The reviewer job accepts, rejects or reassigns.
- **Spend:** per-mission token/spend budget checked before each `agent.task` claim, plus per-org concurrency limits in `qline_claim_jobs`.
- **Harness re-check:** re-run the §3 scenario with real `@qline/ai` calls before deciding whether any graph library is worth it.

## 11. Verification (2026-11-17, local only)

Environment: PostgreSQL 18 (prod is 17.12), Node 24, fresh database migrated from `0001`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run test:unit` | 37 passed, 5 skipped (DB tests skip without `QLINE_TEST_ENV`) |
| Integration (`services/api/test`, 41 tests incl. 12 runtime gates) | 41/41, four consecutive runs |
| `npm run build:api` | `index.mjs` 5.98 MB (unchanged), `function.zip` 1.76 MB |
| `npm audit --omit=dev` | 2 moderate (exceljs → uuid), already on `main`; no new dependencies |

Runtime gates covered by `runtime.integration.test.ts`: idempotent enqueue; exclusive claims under concurrency;
retry with backoff and `run_at`; permanent → `failed`; exhaustion → `dead`; lease expiry recovery and stale-worker
fencing; lost worker on last attempt → `dead` + run `needs_attention`; cancel queued/running jobs; ops list/retry;
cross-tenant isolation of jobs and outbox; outbox → event job → workflow run; rejected approval enqueues nothing and a
forged advance job cannot bypass it; concurrent double approve executes once; interrupted external step →
`needs_attention`, never resent; run cancel expires its approval; schedule keyed once per day; double tick harmless.

Fixes found while building: `kick()` could drop work that arrived while a drain was finishing (now re-runs);
a crash between recording an external result and advancing the step would have collided on the idempotency key
(now reuses the recorded result); a job that gave up left its run looking `running` (now `needs_attention` + notification);
`0006` failed on a fresh database before `qline_app` existed (grant now guarded).

Not verified: behaviour on Neon Functions (waitUntil, SIGINT eviction, trigger re-delivery). That is M4.
