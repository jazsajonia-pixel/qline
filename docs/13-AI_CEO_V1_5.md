# 13 · v1.5 AI CEO — supervisor, missions and delegation (design only)

Status: **design, not implemented.** Implementation starts only after the v1.4 gates (M4 Neon verification, docs/12 §12) and the M5 Ops UI gate pass and Jazz approves. Nothing in this document is live.

Direction (confirmed by Jazz, 2026-11-17): full AI business operating system; **supervised**; parallel and sequential work; Qline-owned Postgres durable jobs (docs/12) as the only runtime; a Qline-owned AI CEO supervisor and orchestration core. BYOK is kept and no paid infra is added.

## 1 · Non-negotiable rules

| # | Rule | Where it is enforced (outside any prompt) |
|---|------|------------------------------------------|
| R1 | The CEO **proposes** a structured plan. It cannot execute, enqueue or approve anything itself. | The model sees only `mission.propose_plan` / `task.submit_result` tools. The plan is validated (zod + graph checks) and written by server code. Execution happens only through `mission.task` jobs in the durable runtime. |
| R2 | Child permissions = **intersection** of the user's role permissions, the workspace policy, the parent agent's allowlist and the tool policy. | `effectivePermissions()` in `@qline/policy` (pure, unit-tested). It is computed when a task is created and stored on the task row, then re-checked at every tool call. A child can never widen it. |
| R3 | Concurrency and spend limits are enforced outside the prompt. | Per-workspace concurrency and per-mission budgets are checked in SQL by the claim function and by the model-call wrapper before each call. |
| R4 | Every task has traceable inputs, outputs, evidence refs and review status. | `mission_tasks` columns plus the `mission_trace` append-only table. |
| R5 | Delegation, retries and replay never bypass approval. | Every external or L2+ tool call goes through the existing `tool_calls` intent + `approval_requests` path. Approvals are stored per tool call and keyed by idempotency key, never inherited by children and never satisfied by context flags. This is the same lesson as the v1.4 `saveAs:"approved"` forgery fix. |
| R6 | Unknown-outcome external actions go to human review. | Reuses v1.4: an `executing`/`unknown` intent puts the task in `needs_attention`. It is resolved only by a person (same contract as `POST /workflow-runs/:id/resolve`). |
| R7 | BYOK; no unnecessary paid infra. | Model calls use the org's stored provider keys (`ai_provider_keys`). Jobs run on Neon Postgres and the existing tick/kick. No Redis, no queue service, no LangGraph Cloud. |
| R8 | LangGraph.js is re-evaluated only for a concrete requirement. | §10 lists the triggers. None applies today. |

## 2 · Concepts

- **Mission**: a goal a person gives the CEO ("Prepare next week's sales push"). It has an owner, a budget, a status and a plan.
- **Plan**: a DAG of **tasks** the CEO proposes. A person approves it before anything runs (supervised mode). A plan can be revised; every revision is a new version, and running tasks keep the version they started under.
- **Task**: one unit of work for one specialist agent (sales, marketing, finance, operations, research) or for a deterministic tool (no model). It has typed inputs, an output schema and a review policy.
- **Edge**: `after` dependencies. Tasks with no unmet dependencies run in parallel (fan-out). A task with several dependencies waits for all of them (fan-in). A chain of single dependencies is a sequential handoff.
- **Review**: a structured output is checked by its schema (always), then by a rule check or the CEO's review (optional), then by a person (required for L2+ effects and for the final mission result in supervised mode).

## 3 · Data model (migration 0008, sketch)

All tables carry `org_id` with tenant RLS (same policy shape as 0007), are owned by the migration owner and are granted to `qline_app` without DELETE. They are append-only where noted.

```sql
create table missions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, workspace_id uuid not null,
  created_by text not null,                 -- human user id; missions are never created by an agent
  title text not null, goal text not null,
  status text not null check (status in ('draft','planning','awaiting_plan_approval','running','waiting_approval',
                                         'needs_attention','paused','completed','failed','cancelled')),
  plan_version int not null default 0,
  budget_tokens int not null,               -- hard cap, input+output
  budget_tool_calls int not null,
  budget_wall_seconds int not null,
  spent_tokens int not null default 0, spent_tool_calls int not null default 0,
  max_parallel int not null default 3,      -- per mission; also bounded by the workspace limit
  result jsonb, result_review text check (result_review in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(), started_at timestamptz, ended_at timestamptz,
  unique (org_id, id)
);

create table mission_plans (                -- append-only; one row per proposed revision
  org_id uuid not null, mission_id uuid not null, version int not null,
  proposed_by text not null,                -- 'agent:<id>' or user id
  plan jsonb not null,                      -- validated MissionPlan (see §4)
  status text not null check (status in ('proposed','approved','rejected','superseded')),
  approval_id uuid,                         -- approval_requests row that decided it
  created_at timestamptz not null default now(),
  primary key (org_id, mission_id, version)
);

create table mission_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, mission_id uuid not null, plan_version int not null,
  key text not null,                        -- stable id inside the plan, e.g. 'research_competitors'
  parent_task_id uuid,                      -- delegation chain (depth limit 3)
  agent_template text,                      -- null = deterministic tool task
  title text not null,
  depends_on text[] not null default '{}',
  input jsonb not null, input_refs jsonb not null default '[]',
  output_schema jsonb not null,             -- JSON Schema subset; validated server-side
  output jsonb, evidence_refs jsonb not null default '[]',
  effective_permissions text[] not null,    -- R2, frozen at creation
  tool_allowlist text[] not null,           -- intersection, frozen
  status text not null check (status in ('blocked','ready','queued','running','waiting_approval','needs_attention',
                                         'review','succeeded','failed','cancelled','skipped')),
  review_status text not null default 'pending' check (review_status in ('pending','auto_passed','ceo_passed','human_passed','rejected')),
  attempts int not null default 0, max_attempts int not null default 2,
  spent_tokens int not null default 0,
  job_id uuid,                              -- the mission.task job running it
  error text,
  created_at timestamptz not null default now(), started_at timestamptz, ended_at timestamptz,
  unique (org_id, mission_id, plan_version, key)
);

create table mission_trace (                -- append-only audit/trace; never updated
  id bigserial primary key, org_id uuid not null, mission_id uuid not null, task_id uuid,
  at timestamptz not null default now(),
  actor text not null,                      -- 'user:<id>' | 'agent:<id>' | 'system'
  kind text not null,                       -- plan.proposed, plan.approved, task.ready, task.started, model.call,
                                            -- tool.intent, tool.result, approval.requested, review.*, budget.*, pause.*
  data jsonb not null                       -- inputs/outputs digests, token counts, refs; no secrets, no raw keys
);

create table workspace_controls (
  org_id uuid not null, workspace_id uuid not null,
  paused boolean not null default false,          -- stop starting new tasks; running ones finish their current step
  emergency_stop boolean not null default false,  -- cancel all running tasks now; refuse all tool intents
  max_concurrent_tasks int not null default 3,    -- across all missions in the workspace
  monthly_token_cap int,                          -- optional, BYOK cost guard
  updated_by text, updated_at timestamptz not null default now(),
  primary key (org_id, workspace_id)
);
```

Existing tables reused: `agent_runs` (trigger `'delegation'` already exists) gains a `mission_task_id` column. `tool_calls` and `approval_requests` are unchanged and reached through the same functions as workflows. `jobs`/`job_attempts` gain one kind, `mission.task`, plus `mission.tick` for fan-in checks.

## 4 · Structured contracts

```ts
// What the CEO may propose. Anything else is rejected before it is stored.
const MissionPlan = z.object({
  summary: z.string().max(2000),
  tasks: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    title: z.string().max(200),
    agent: z.enum(['sales','marketing','finance','operations','research']).nullable(), // ceo cannot assign itself
    tool: z.string().optional(),            // deterministic task (no model), must be an allowed tool
    dependsOn: z.array(z.string()).max(8),
    input: z.record(z.unknown()),           // may reference outputs: { "$from": "task_key.field" }
    output: OutputSchema,                   // small JSON-Schema subset: object/string/number/boolean/array, required[]
    review: z.enum(['schema','ceo','human']),
  })).min(1).max(20),
});
```

Server-side plan checks (all must pass, otherwise the plan is rejected with reasons the CEO can see once):
acyclic graph (Kahn's algorithm), every `dependsOn` and `$from` resolves to an earlier key, depth ≤ 6, every `agent`/`tool` is allowed by R2, the estimated budget is within the mission budget, and no task carries the reserved keys `approved`, `approved_steps`, `trigger` or `approval` (the v1.4 forgery lesson).

Task results are submitted through `task.submit_result({ output, evidenceRefs })`. The output is validated against the task's `output_schema`. If invalid, the task is retried once with the validation error, then goes to `failed`. Evidence refs must point at real rows in the same org (`document:<id>`, `contact:<id>`, `tool_call:<id>`, `gmail:<msgId>`), and the server verifies them before storing.

## 5 · Execution flow

```
person ──POST /missions──▶ missions(draft)
          │  enqueue mission.plan job
          ▼
mission.plan job: CEO model call (BYOK) with tools = {mission.propose_plan} only
          │  server validates plan → mission_plans(v1, proposed) → approval_request (human, L2)
          ▼
person approves plan ──▶ mission running; tasks inserted (blocked/ready); mission.tick enqueued
          ▼
mission.tick job (idempotent):  for each ready task, while workspace + mission concurrency allow:
          claim slot (SQL, §6) → mission_tasks.status=queued → enqueue mission.task(task_id)
          ▼
mission.task job: specialist agent run (agent_runs.trigger='delegation') with frozen allowlist
          │  every tool call → existing decideTool + tool_calls intent + approval_requests
          │  external send → intent 'executing' → result | unknown → needs_attention (R6)
          │  submit_result → schema check → review (schema | ceo | human)
          ▼
task succeeded → outbox event mission.task.done → mission.tick (fan-in: unblock dependents)
all tasks terminal → CEO summary (structured) → result_review pending → person accepts/rejects
```

- **Parallel fan-out**: independent ready tasks are enqueued together, up to `min(mission.max_parallel, workspace free slots)`.
- **Fan-in**: a dependent becomes `ready` only when every dependency is `succeeded` with review passed. A failed or rejected dependency makes the dependent `skipped`, and the mission goes to `needs_attention` (supervised: a person decides whether to revise the plan).
- **Sequential handoff**: a dependency whose input references `$from` gets the upstream output copied into its `input` at ready time. It is never read by the model from shared state, so a task sees only what its contract declares.
- **Revision**: the CEO may propose plan v(n+1) only while the mission is `needs_attention` or when a person asks. Running tasks finish under their own version, and the new version must be approved again.
- **Replay/retry**: a `mission.task` job retry re-reads the task row. If the task's tool intents exist, the v1.4 rules apply (reuse result / unknown → human). A retried task gets no new approvals; approvals are tied to tool-call idempotency keys `mt:<task_id>:<n>`.

## 6 · Limits, pause and emergency stop (outside the prompt)

- **Concurrency**: `qline_claim_mission_slot(workspace)` runs in the same transaction that moves a task to `queued`: first `select max_concurrent_tasks from workspace_controls where workspace_id=$1 for update` (locks the workspace's control row, which serialises competing ticks), then `select count(*) from mission_tasks where workspace_id=$1 and status in ('queued','running')` and compare. (Postgres does not allow `FOR UPDATE` on an aggregate, so the lock is on the control row.) The tick never over-enqueues, even with parallel ticks; this is tested like the v1.4 double-tick tests.
- **Budget**: the model-call wrapper does `update missions set spent_tokens = spent_tokens + $est where id=$1 and spent_tokens + $est <= budget_tokens returning ...` **before** each call and reconciles after. No row means the budget is exhausted, so the task moves to `needs_attention` with `budget.exceeded` in the trace. Tool calls and wall time are handled the same way. The workspace monthly cap is checked the same way.
- **Pause**: `workspace_controls.paused = true` makes the tick start nothing new. Running tasks stop at their next model or tool boundary (checked by the job's heartbeat, the same mechanism as v1.4 `cancel_requested`).
- **Emergency stop**: sets `emergency_stop`, marks every running `mission.task` job `cancel_requested`, expires pending mission approvals and makes `decideTool` deny every new intent for the workspace. It is reachable from the mobile app with one confirmed tap (owner/admin) and logged in `audit_events`. Clearing it is a separate, audited action. Workflows (v1.4) obey the same flag.

- **Latency on Neon Free**: the cron tick stays `*/15` (docs/12 §12.4: `*/5` keeps Postgres awake and exceeds the 100 CU-hour cap). Mission steps must therefore advance through the request/finish **kick** (a finished task enqueues and kicks its dependants), and cron is only the safety net for retries and recovery. Measured kick latency on Neon: about 0.4 s.

## 7 · APIs (v1.5)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/missions` | `agents.use` + human | title, goal, budget (bounded by workspace defaults) |
| GET | `/missions`, `/missions/:id` | `agents.use` | includes plan, tasks, spend, trace summary |
| GET | `/missions/:id/trace` | `audit.read` or mission owner | paged, append-only |
| POST | `/missions/:id/plan/decision` | approval permission for plan risk (L2 → `approvals.decide:medium`) | approve / reject a proposed version |
| POST | `/missions/:id/cancel` | owner of mission or `workflows.manage` | cascades to tasks and jobs |
| POST | `/mission-tasks/:id/review` | `approvals.decide:medium` | accept / reject a task output under `human` review |
| POST | `/mission-tasks/:id/resolve` | `workflows.manage` + human | same contract as the run resolve (happened / not_happened / retry) |
| GET/PUT | `/workspaces/:id/controls` | `org.manage` (PUT), `workflows.manage` (GET) | pause, emergency stop, limits |

All writes are audited. All reads go through RLS. No endpoint lets an agent principal act; agent actions come only from jobs carrying the mission's frozen context.

## 8 · Security boundaries

1. **Prompt injection from data** (emails, documents, web text) can change what a model *says*, not what it *may do*. Permissions are frozen per task (R2), approvals are per intent (R5) and limits are in SQL (R3).
2. **No privilege laundering through delegation**: a child's allowlist ⊆ parent's, depth ≤ 3. The CEO template's allowlist for v1.5 is planning tools only, no send tools.
3. **Output forgery**: outputs are data. Reserved keys are rejected, and no output field is ever read as an approval or a permission.
4. **Cross-tenant**: every new table has RLS; tests reuse the v1.4 tenant harness (B cannot see or touch A's missions, tasks, trace or controls).
5. **Secrets**: provider keys stay encrypted (`QLINE_DATA_KEY`). The trace stores digests and token counts, never keys or full third-party payloads.
6. **Cost**: BYOK keeps model spend on the customer's key; the budgets are the guard against runaway loops.

## 9 · Phases and gates

| Phase | Scope | Gate (all must pass, on a Neon preview branch) |
|---|---|---|
| P0 | `effectivePermissions()`, plan validator, output-schema validator in `@qline/policy` (pure) | Unit tests: intersection never widens; cycles and forward refs rejected; reserved keys rejected |
| P1 | Migration 0008 (tables, RLS, grants, claim-slot function), workspace controls API, emergency stop wired into `decideTool` for workflows too | Clean-DB and upgrade migration on Neon; RLS/grant checks; stop denies intents (workflow + agent paths) |
| P2 | Missions + plan proposal + plan approval (no task execution) | Plan approval cannot be bypassed by replaying `mission.plan`; rejected plans never create tasks |
| P3 | `mission.task` sequential execution, structured results, review | Schema-invalid outputs fail; evidence refs verified; approvals per intent; unknown outcome → human |
| P4 | Parallel fan-out/fan-in with concurrency slots and budgets | Concurrent ticks never exceed limits; budget exhaustion stops before the call; fan-in waits for all |
| P5 | Mobile: missions list, plan review, task review, trace, pause/emergency stop | Widget tests for every control; rendered review in dark and light; Live AI remains dark |
| P6 | Hardening: chaos (DB restart, lease loss, provider 5xx/timeouts) on Neon, like v1.4 S9 | Zero duplicate sends; all interrupted external steps end in human review |

## 10 · LangGraph.js re-evaluation triggers

Re-evaluate only if one of these becomes a concrete requirement: (a) long-lived cyclic agent loops with checkpointed branching that the task DAG cannot express; (b) a need for its human-in-the-loop interrupt semantics *inside* a single model turn; (c) a large library of ready-made graphs worth adopting. Today the durable jobs, outbox and approval tables already give durable state, retries and human gates. LangGraph's checkpointer would duplicate them and add a second source of truth for approvals, which conflicts with R5.

## 11 · Test requirements (summary)

Unit (policy, validators), real-Postgres integration (local + Neon preview), deployed-function e2e (like `neon_e2e.mjs`), and mobile widget tests. Every bug found gets a regression test that fails on the old code. Required scenarios include: forged approval in task output; child asking for a tool the parent lacks; replayed `mission.task` after approval rejection; two ticks racing for the last concurrency slot; budget hit mid-task; emergency stop during an external send (→ unknown → human); cross-tenant access to each new table; plan revision while tasks run.
