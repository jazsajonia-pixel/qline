# 17 · Action safety (Milestone 1)

Status: implemented on branch `feat/m1-action-safety`, **not merged, not migrated in production, not deployed**.
This doc is the Phase 0 audit record plus the M1 design. Later milestones (M2–M11) are planned in §G.

## A. Phase 0 audit (verified against the code at `main` 2f220ee / v1.6.0)

### Architecture, as it actually is

| Area | Where | Notes |
|---|---|---|
| Mobile app | `apps/mobile` (Flutter, Riverpod) | Android APK via `release.yml` |
| API | `services/api` (Hono + Better Auth) on Neon Functions | `src/app.ts` mounts `/v1` modules |
| Database | Neon Postgres, `packages/schema/migrations` (0001–0012, `9999_app_role` re-runs every time) | RLS on every tenant table, runtime role `qline_app` |
| Policy | `packages/policy` (`decideTool`, `TOOL_POLICIES`, risk L0–L3) | autonomy levels in docs/16 |
| AI runner | `services/api/src/agent/runner.ts` | chat tool calls |
| Missions | `services/api/src/modules/missions.ts` | AI CEO tasks run tools via `runTaskTool` |
| Approvals | `services/api/src/modules/agents.ts` | approve → execute |
| Workflows | `services/api/src/modules/workflows.ts` | automation steps (email/slack/calendar) and tool actions |
| Provider calls | `integrations/oauth.ts` `api()`, `integrations/connectors.ts` `call()` | 20 s timeout |
| Scheduler | `modules/system.ts` tick | outbox relay, scheduled workflows, syncs, job drain |

Baseline before changes: typecheck clean; 80 unit tests and 111 integration tests passed against local Postgres 18;
`main` CI run 44231128311 green.

### Findings

| # | Finding | Verdict |
|---|---|---|
| 1 | Full-autopilot daily cap was counted from `tool_calls` org-wide (not per workspace) and checked before the call without a lock, so parallel workers could pass the cap together. | **Confirmed.** Fixed (§B). |
| 2 | Runner, missions and approvals ran the provider call inside the DB transaction and marked any exception `failed`. A timeout after Slack/Gmail accepted the request was reported as failed and could be retried. | **Confirmed.** Fixed (§B). |
| 3 | Workflow automation steps (email/slack/calendar) already committed intent first and used `unknown`. Workflow *tool* actions (`forms.create`, `sheets.create`, `calendar.create`…) did not. | **Confirmed.** Fixed. |
| 4 | Google Forms: `setPublishSettings` errors were swallowed (`catch {}`) and the form was reported as ready. | **Confirmed.** Fixed (§C). |
| 5 | "Forms responses need `forms.responses.readonly`." | **Not accepted.** Google documents that `forms.responses.list` and `forms.setPublishSettings` accept `drive.file` ([responses.list](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list), [setPublishSettings](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/setPublishSettings)). `drive.file` only covers forms Qline created, so the tool now says that on 403/404 instead of adding a broader scope. |
| 6 | OAuth token exchange (`postForm`) has no timeout; Google/Microsoft identity fetch has no timeout or status check; token refresh is not single-flight. | Confirmed, **deferred to M11** (no change in M1). |
| 7 | API pool max is 5 connections; nested `withTenant` inside a transaction can deadlock under load. | Noted; M1 code avoids nested connections. |

## B. Honest outcomes and the atomic cap

1. **Intent first.** Every allowed tool call is committed as `executing` before any provider request (runner, missions,
   approvals, workflow tool actions).
2. **Reservation.** Under full autopilot an L3 action takes a slot in `external_action_reservations` in that same
   transaction, under `pg_advisory_xact_lock(hashtextextended('qline.external_cap:'||workspace_id,0))`. The limit is
   re-read inside the lock. Counting is **per workspace**, rolling 24 hours, `status <> 'released'`.
   No slot → the action falls back to a human approval (never silently dropped, never run over the cap).
3. **Tracking.** `core/external.ts` wraps execution in `trackExternal` (AsyncLocalStorage). `api()` and `call()` record
   each mutating request: 2xx = confirmed; 4xx except 408, or Slack `ok:false` = refused; timeout, network error, 408,
   5xx = no answer.
4. **Outcome.** A throw with nothing sent or everything refused → `failed` (slot released). Anything else, including
   "provider confirmed, then Qline's own commit failed" → `unknown` (slot consumed). Unknown actions are **never
   retried automatically**; replays of the same step return the recorded status without acting.
5. **Idempotency.** Stripe POSTs send `Idempotency-Key: qline-<toolCallId>:<n>` (deterministic per request).
6. **Reconciler.** The scheduler tick calls `qline_mark_stale_executing(15, EXTERNAL_WRITE_TOOLS)`: actions still
   `executing` after 15 minutes become `unknown` if they touch a connected app (slot kept) or `failed` if Qline-only
   (their work rolls back with the status update, so they definitely did not happen).
7. **Resolution.** `GET /v1/actions/unknown` lists unresolved unknowns. `POST /v1/actions/:id/resolve
   {resolution:'done'|'not_done', note?}` records who checked (role must be able to decide that risk level),
   writes an `action.resolved` audit event, and `not_done` returns the slot.
8. **Errors.** Stored/shown errors pass through `safeError` (masks Bearer, `ya29.`, `xox*-`, `sk_/rk_`, `gh*_`,
   `github_pat_`, `AIza…`; max 300 chars).

`EXTERNAL_WRITE_TOOLS` (`packages/policy`) lists every L3 tool plus L2 tools that write to a connected app
(`calendar.create`, `forms.create`, `sheets.create/append`, `drive.create/update`, `notion.create/append`). A unit test
fails if a new L3 tool is not in it.

## C. Google Forms

API-created forms after 2026-06-30 start unpublished ([Forms API](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms)).
`publishForm()` calls `setPublishSettings` (`updateMask: 'publishState'`), then reads the form back. `accepting` is true
only when Google reports `isPublished && isAcceptingResponses`. Otherwise the tool and the lead-form endpoint return
`accepting:false` + `publishError`, the AI is told not to share the link as ready, and the app shows "Not accepting
responses yet". Audit: `form.published` / `form.publish_unverified`.

## D. Autopilot policy (what runs without asking)

| Level | Runs without asking | Needs approval | Denied |
|---|---|---|---|
| supervised | reads, drafts | every change and every external action | per policy |
| autopilot | L1/L2 Qline writes, delegation | L3 external actions, deletes, `config.propose` | per policy |
| full | also L3 external actions and deletes, **up to `dailyExternalLimit` per workspace per rolling 24 h** | anything past the limit, `config.propose` | per policy, emergency stop |

Every action is audited; unknown outcomes are listed for a person to resolve.

## E. Migration and recovery

`0013_m1_action_safety.sql` is additive: new table `external_action_reservations` (RLS `tenant_isolation`), new
nullable `tool_calls` columns (`resolution`, `resolution_note`, `resolved_by`, `resolved_at`), two partial indexes, one
SECURITY DEFINER function. It backfills reservations for the last 24 h of allowed L3 calls so the cap stays correct at
deploy time. Down migration is in the file header; the v1.6.0 API ignores all of it, so rolling the API back is safe
without running it.

## F. Tests

- Unit (`services/api/test/unit.test.ts`, `packages/policy/test/policy.test.ts`): classification of timeout/5xx/408/4xx/
  Slack `ok:false`/GET; provider-success-then-Qline-failure → unknown; per-request idempotency keys; secret masking;
  Forms publish verified / refused / silently unpublished / no publish state; every L3 tool is in `EXTERNAL_WRITE_TOOLS`.
- Integration (`services/api/test/action-safety.integration.test.ts`, real Postgres, app role): 10 concurrent
  reservations at limit 3 → exactly 3 (and the test fails if the advisory lock is removed — checked by mutation);
  workspace isolation; release on failure; 24 h window; autopilot never reserves; runner Slack timeout → `unknown`,
  one request, slot kept, listed, cross-org 404, resolve validation, `not_done` returns slot, double resolve 409,
  audit event; cap reached → approval; approving into a timeout → `unknown`; reconciler external → unknown,
  internal → failed, fresh untouched.

Not covered by automated tests: a real Google Form against Google, Stripe header on a live request, the mobile
"Not accepting responses" label (covered only by `flutter analyze`/`flutter test` in CI), and a UI for resolving
unknown actions (API only in M1).

## G. Milestone plan

| Run | Milestones |
|---|---|
| 1 | Phase 0 audit + M1 action safety |
| 2 | M2 conversation resume / New Chat + context ledger (docs/18). M3 and the unknown-action UI moved to run 3. |
| 3 | M3 Markdown + collapsed tool trace with friendly names, unknown-action UI, M4 knowledge canvas + in-chat Knowledge toggle and context transparency, M5 Android Back exit confirm (docs/19). M10 (Gemini keys) and M11 (OAuth timeouts, single-flight refresh) did not fit and remain open. |

M6 live voice, M7 Drive files/inline images, M8 customization, M9 custom agents need their own runs; they will not
be done properly inside three runs.
