# 20 — Personal AI OS: Milestone 0 baseline, gap matrix and plan

Prepared 2026-11-19 for the "Qline — Comprehensive product direction" brief (M0–M12). This is **Milestone 0 only**:
an audit of the current code and production, an evidence-backed gap matrix, architecture decisions to approve, and a
phased plan. No feature code, migration, merge, deploy or production change was made for this document.

## A. Checkpoint (verified 2026-11-19)

| Item | State | Evidence |
|---|---|---|
| main | `7412540` (Merge #24, Release v1.7.0), clean, no open PRs | `git log`, `gh pr list` |
| Main CI | green: api, mobile, production-smoke (1.7.0) | run 44411250088 |
| Release | Qline 1.7.0 (Latest), `qline-1.7.0.apk`, versionCode 9 | GitHub release v1.7.0, release run 44412369500 |
| Production API | `/v1/health` = 1.7.0, `/health/ready` ok (database, storage) | live check 2026-11-18 23:34 UTC |
| Neon function | `api` deployment #13, completed and active | Neon `get_function` |
| Migrations (prod) | 0001, 0003–0014, 9999 (there is no 0002 file in the repo) | `schema_migrations` (read-only query) |
| Stuck actions (prod) | 0 `executing`, 0 unresolved `unknown` tool calls | read-only query |
| RLS (prod) | 8 tables without RLS, all global by design: Better Auth `user`, `session`, `account`, `verification`; `schema_migrations` (no app access); `platform_oauth_apps`, `oauth_states`, `signin_requests` | `pg_class.relrowsecurity` |
| Neon branches | `main`, `pre-v1-7-restore-point`, `preview-v1-7`, `preview-v1-6`, and older preview/restore branches kept for the owner to decide | `list_branches` |
| Repo instructions | no `AGENTS.md` in the repo; README, docs 00–19 and release notes exist | file listing |
| Device QA | **never performed** for any release so far | handoff history |

Stack (unchanged): Flutter 3.50 + Riverpod (`apps/mobile`), Hono + Better Auth on a Neon Function (`services/api`),
SQL-first migrations with tenant RLS (`packages/schema`), L0–L4 risk policy (`packages/policy`), model gateway
(`packages/ai`). Tenant root is the **organization**; every request runs in an org-scoped transaction
(`services/api/src/core/db.ts`, `qline_org()` policies).

## B. Gap matrix

Status: **IMPLEMENTED** (code + automated tests), **PARTIAL**, **MISSING**, **REGRESSED**, **NOT VERIFIABLE** (needs a
device, live provider or owner credentials). "Tests" means the automated suites in CI; none of this is device-verified.

### M1 — Reliability and security gaps from the prior audit

| Requirement | Status | Evidence / gap |
|---|---|---|
| Atomic autopilot cap, per workspace | IMPLEMENTED | `external_action_reservations` + advisory lock (`core/controls.ts`, migration 0013); test "cap race: 10 concurrent reservations at a limit of 3" (`test/action-safety.integration.test.ts:199`); mutation check done in M1 |
| Release/reconcile reservations | IMPLEMENTED | `qline_mark_stale_executing` (0013) releases Qline-only, keeps connected-app slots; test `:402` |
| Intent before provider call; unknown outcome; no blind retry | IMPLEMENTED | `core/external.ts` classification; runner/missions/approvals/workflow steps (`integrations/steps.ts:12`); test `:274` |
| Provider idempotency keys | PARTIAL | Stripe only (`integrations/connectors.ts:23,391`). Gmail/Slack/Notion/GitHub have no provider idempotency; covered by "unknown, never retried" |
| "Needs checking" workflow | IMPLEMENTED | `GET /actions/unknown`, resolve route, `screens/needs_checking.dart` |
| DB failure after provider success | PARTIAL | reconciler covers lost commits (`:402`); no explicit test that injects a DB failure right after a provider success |
| Google Forms scope + publish read-back | IMPLEMENTED | `drive.file` only (`integrations/oauth.ts:23`); `setPublishSettings` then read-back of `publishState` (`integrations/services.ts:223-232`). Live Google call NOT VERIFIABLE (no registered test run) |
| Session lifetime | PARTIAL | 30-day rolling bearer sessions (`core/auth.ts:16`); documented options in docs/15, no owner decision yet |
| Session tokens at rest | MISSING | Better Auth `session.token` stored as plain text (`0001_core.sql:21`) |
| Revoke-all / session list | MISSING | no route (`rg revokeSessions` finds nothing) |
| Password recovery, email verification | MISSING | `emailAndPassword` has no `sendResetPassword` / verification (`core/auth.ts:15`); needs an email provider (owner decision, possible cost) |
| Shared rate limiting | MISSING | `rateLimit.storage: 'memory'` (`core/auth.ts:17`) is per instance on serverless |
| Streaming upload limits | MISSING | `Content-Length` pre-check, then `formData()` + `arrayBuffer()` buffer the whole body (`modules/files.ts:65-70`, `modules/imports.ts:331-336`); a missing/false length is only caught after buffering |
| Parser bounds / isolation | PARTIAL | 10 MB file cap, 20 000 rows (`modules/imports.ts:15-16`); parsers run in the API process; no time/memory/decompressed-size limit |
| OAuth timeouts | PARTIAL | provider API calls 20 s (`oauth.ts:270-282`), Notion token 20 s, GitHub identity 15 s. **No timeout** on `postForm` (Google/Microsoft/Slack/GitHub token exchange and refresh, `oauth.ts:170`) or on the Google/Microsoft identity fetch (`oauth.ts:229`), which also skips status checks |
| Single-flight refresh | MISSING | `accessToken()` refreshes without a lock (`oauth.ts:244-263`); concurrent runs can refresh at once |
| Transient refresh errors | REGRESSED-risk | any non-OK refresh (including 5xx/timeout once added) marks the connection `expired` (`oauth.ts:256-258`); should only do that for `invalid_grant`-type answers |
| GitHub least privilege | PARTIAL | GitHub App model with `user/installations` (`connectors.ts:261-271`), no OAuth scopes requested (`oauth.ts:34`); App permissions live in GitHub settings and are NOT VERIFIABLE from the repo |
| Docs match code | PARTIAL | README still says "business operating system for small teams" and omits v1.5–1.7; docs/10 T5 claims KMS envelope encryption (code: AES-256-GCM with one key derived from `QLINE_DATA_KEY`, `core/secrets.ts:5-9`); docs/10 T9 claims a sandboxed parser worker (not implemented); no dated known-limitations section |

### M2 — Conversation continuity and efficient context

| Requirement | Status | Evidence / gap |
|---|---|---|
| Reopen resumes current chat; explicit New chat | IMPLEMENTED | `core/chat_resume.dart`, `test/m2_resume_test.dart`; docs/18 §A |
| Resume a running answer without duplicating | IMPLEMENTED | `active_run` + replay; test `context-ledger.integration.test.ts:348` |
| Account / org isolation of the pointer | IMPLEMENTED | pointer per org + account, cleared on sign-out (docs/18) |
| Preserve draft text, attachments, scroll | MISSING | draft and pending attachments are in-memory only (`live.dart`); no scroll restore |
| History browsing | IMPLEMENTED | Conversations sheet with New chat row |
| Context ledger with scope, freshness, invalidation | IMPLEMENTED | `agent/context-ledger.ts`, migration 0014; tests `:196-:436` (reuse, write invalidation, fresh/expiry, isolation, connected-app reuse) |
| ETag/version and external change signals | MISSING | TTL only for connected apps; no webhooks |
| Measured savings (calls, tokens, latency, hit rate) | PARTIAL | per-run `input_tokens`/`output_tokens` (`runner.ts:134`), ledger `hits`, `duration_ms`, `provider_reads`; no report or dashboard; no baseline comparison |
| Prompt/context compaction | MISSING | history is the last 20 messages verbatim (`runner.ts:82-84`); no summaries with provenance |

### M3 — Chat presentation and process transparency

| Requirement | Status | Evidence / gap |
|---|---|---|
| Safe streaming Markdown, no raw markers | IMPLEMENTED | `ui/markdown.dart`; `test/m3_markdown_test.dart` (12) |
| Safe links (http/https only, confirm) | IMPLEMENTED | `safeUrl`, tests "only http and https links open", "a link asks before opening" |
| Attachments: name/type/size + real open/download | PARTIAL | chips show name/size (`ui/chat_artifacts.dart:375-400`) but sent-message chips have **no tap action** (`live.dart:912`) — dead chip; images open via `ChatImage` |
| Inline images vs documents | PARTIAL | `image` and `chart` artifacts only (`chat_artifacts.dart:22-26`); no file/document artifact type |
| Collapsed trace with status, tap to expand | IMPLEMENTED | `ui/activity_trace.dart`; `test/m3_run3_test.dart` |
| Safety states visible when collapsed | IMPLEMENTED | test "approvals, failures, changes and unknown outcomes stay visible while collapsed" |
| Friendly labels; technical detail on expand | IMPLEMENTED | `packages/policy` `toolLabels`; test "tool names only appear as a detail when opened" |
| Agent assignments / mission detail in chat trace | PARTIAL | mission trace exists in the missions screen (`/missions/:id/trace`), not linked from the chat trace |
| TalkBack semantics | PARTIAL | Semantics labels in code; NOT VERIFIABLE without a device |

### M4 — Knowledge OS and graph

| Requirement | Status | Evidence / gap |
|---|---|---|
| Pan/zoom/drag/fit/reset, search, filters, focus, LOD, list view | IMPLEMENTED | `screens/knowledge_graph.dart`; `test/m3_run3_test.dart` (controls, filters, positions); device gestures NOT VERIFIABLE |
| Persisted positions, isolated per account | PARTIAL | key `qline.kgpos.<org>.<view>` (`knowledge_graph.dart:336`) is per org, **not per user**, and is not cleared on sign-out |
| Large graphs, communicated cap | PARTIAL | hard cap 150 nodes / 400 edges (`modules/knowledge.ts:39-40`); the app shows "truncated" (`knowledge_graph.dart:318`); no paging or neighbourhood loading |
| Offline state | PARTIAL | error + retry; no offline cache |
| Knowledge toggle left of composer, drawer over chat | IMPLEMENTED | `live.dart` + `showKnowledgeSheet`; test "the toggle sits left of the composer…" |
| Selected / available / included indicator | PARTIAL | chips = selected; message label = sent; no "available to this chat" list or per-request "actually included" confirmation from the server |
| RLS + untrusted context | IMPLEMENTED | `modules/agents.ts` (memory.read, RLS load, 404), `runner.ts` `untrusted('knowledge:<id>')`; `test/run3.integration.test.ts` |
| Provenance/citations to source notes | PARTIAL | ids/titles stored in `meta.knowledge`; the answer does not cite them |
| Transparent, reversible memory capture | PARTIAL | `memory.propose` / `knowledge.propose` create "proposed" entries (L1), editable/deletable; no automatic capture (K4) |
| Phone drawer / tablet side panel | PARTIAL | bottom sheet on all sizes; no side-by-side layout |

### M5 — Exit and navigation

| Requirement | Status | Evidence / gap |
|---|---|---|
| Exit confirm at root only, no stacking | IMPLEMENTED | `core/back_exit.dart`, `shell.dart` PopScope; tests "on Home, Back asks once…", "on another tab…", "on a nested screen…" |
| Dirty chat (text/upload) asks | IMPLEMENTED | `live.dart` PopScope; test "leaving the chat with an unsent message asks first" |
| Predictive Back | MISSING | no `android:enableOnBackInvokedCallback` in the manifest |
| Device test (button + gesture) | NOT VERIFIABLE | no device QA |

### M6 — Live voice 2.0

| Requirement | Status | Evidence / gap |
|---|---|---|
| Hands-free with endpointing | PARTIAL | platform recognizer (`speech_to_text`) with fixed `pauseFor` 2.2 s / 3 s and `listenFor` 60 s (`live.dart:547-551`); no adaptive VAD |
| Streaming partial transcription | IMPLEMENTED | `partialResults: true` |
| Natural TTS | PARTIAL | server TTS (Gemini / OpenAI) returns a whole clip (`modules/voice.ts:31,81,99`); device TTS fallback; not streaming |
| Barge-in by voice | MISSING | interrupt is a tap on the core (`live.dart:191`); mic is not open while speaking |
| Stale-turn cancellation | PARTIAL | `Speaker._session` counter invalidates old playback (`core/voice.dart`); no turn ids across STT→LLM→TTS |
| Echo cancellation, route changes, audio focus, Bluetooth | MISSING / NOT VERIFIABLE | not handled in code; device-only |
| Filipino-English, vocabulary | MISSING | no locale selection or custom vocabulary |
| Explicit voice state machine | PARTIAL | `CoreState` UI states exist; not a formal session state machine |
| Benchmarks (WER, latency, false endpoints) | MISSING | none |

### M7 — Google Drive files in chat

| Requirement | Status | Evidence / gap |
|---|---|---|
| Drive search/list with metadata | PARTIAL | `drive.search` returns name/type/modified/link/size (`connectors.ts:66-85`); **no MIME filter, no `pageToken`, no `createdTime`** |
| "Latest" ordering | PARTIAL | `modifiedTime desc` only when the query is empty; relevance otherwise |
| Fetch content / thumbnail | PARTIAL | `drive.read` extracts text from documents; images and binaries are not fetched |
| Inline image from Drive | MISSING | `image.show` only shows files uploaded to Qline (`tools-files.ts:237-246`) |
| Downloadable file artifacts (name + MIME) | MISSING | no file artifact type; `/files/:id/content` exists for Qline files |
| Permission errors, revoked OAuth, rate limits | PARTIAL | `guard()` maps provider errors; revoked → `expired`; no rate-limit backoff |
| Live test with a Drive account | NOT VERIFIABLE | needs owner's test account; `drive.readonly` is a restricted scope (verification + CASA to publish) |

### M8 — AI-controlled customization and mission proposals

| Requirement | Status | Evidence / gap |
|---|---|---|
| AI proposes a mission into the mission UI | MISSING | missions are created by `POST /missions` (human); no `missions.propose` tool (tool list in `agent/*.ts`) |
| Typed proposal tools for settings/workflows/agents | MISSING | only setup proposals via onboarding (`modules/onboarding.ts:303`) and `knowledge.propose`/`memory.propose` |
| Preview/diff, accept/edit/reject | PARTIAL | pattern exists for setup (`screens/setup.dart` "Proposed setup · vN", diff) and mission plans (`mission_plans.status proposed`) — reusable |
| Audit trail, risk policy | IMPLEMENTED (foundation) | `core/audit.ts`, `packages/policy` |
| Undo/rollback | PARTIAL | `configuration_versions` for setup; nothing generic |

### M9 — User-created custom agents

| Requirement | Status | Evidence / gap |
|---|---|---|
| Create custom agents | MISSING | six fixed templates; `unique (org_id, workspace_id, template)` and template check (`0001_core.sql:338-345`); no create route |
| Edit name/instructions/tools, versions | IMPLEMENTED (built-ins) | `PATCH /agents/:id` with `agent_versions` and template policy floor (`modules/agents.ts:64-96`) |
| Revert version | MISSING | versions are kept, no revert route |
| Model/provider per agent | PARTIAL | `agent_versions.model` exists; not editable in the route |
| Knowledge/domain scope per agent | PARTIAL | `memory_scopes` column exists, unused in the route |
| Budgets, concurrency | PARTIAL | workspace autonomy cap and mission budgets exist; no per-agent budget |
| Test-run before activation | MISSING | — |

### M10 — Multiple Gemini keys and routing

| Requirement | Status | Evidence / gap |
|---|---|---|
| Multiple keys per provider | MISSING | `ai_provider_keys` primary key `(org_id, provider)` = one key per provider per org (`0004_ai_providers.sql:3-15`) |
| Encrypted storage, masked hint, status | IMPLEMENTED (single key) | `key_ciphertext` (AES-GCM, `core/secrets.ts`), `key_hint`, `status`, `checked_at` |
| Aliases, per-agent assignment, routing, cooldown, failover | MISSING | — |
| Usage per key/agent | MISSING | usage per run only |

### M11 — Personal AI experience

| Requirement | Status | Evidence / gap |
|---|---|---|
| Use Qline without creating a business | MISSING | sign-up asks "Name your business" / "Join your team" (`screens/auth.dart:243`); every user needs an organization |
| Personal knowledge | PARTIAL | knowledge entries are private to their author by default (`memory_records.visibility/owner_user_id`, 0012) — inside an org |
| Domains/spaces (enable, rename, hide) | MISSING | workspaces exist (one per org in practice); no domain concept |
| Domain inference / explicit switch | MISSING | org switcher only |
| Personal goals, routines, reminders, learning, career | MISSING | business entities only (tasks, projects, contacts, leads); `notify.me` and Calendar tools exist |
| Business features stay intact | IMPLEMENTED | current product |

### M12 — UX, accessibility, performance

| Requirement | Status | Evidence / gap |
|---|---|---|
| Light and dark themes | IMPLEMENTED | `ui/theme.dart:91` |
| Reduced motion | IMPLEMENTED | setting + system flag (`main.dart:29`, `settings.dart:74`) |
| TalkBack, scalable text, tablet layouts | NOT VERIFIABLE | semantics in code; no device or tablet QA |
| Performance instrumentation | MISSING | no client metrics |
| Physical-device QA | MISSING | never done |

## C. Architecture decisions (proposed, need owner approval)

### ADR-1 Personal identity and domains — recommend **B: personal default organization**

- **A. Person as root, organizations optional.** Every tenant policy (`org_id = qline_org()` on the 48 RLS tables) and the
  `X-Qline-Org` request model would need a second ownership path. High risk to tenant isolation; large migration.
- **B. Keep the organization as the tenant, give every user a personal organization.** At sign-up (and backfilled for
  existing users on first sign-in) create one organization with `settings.kind = 'personal'`, the user as sole
  owner, and one workspace. Business organizations and teams stay exactly as they are. RLS is unchanged; personal data
  is isolated by the same policies; leaving a team never touches personal data.
- **Domains** are labels inside a workspace (a `domains` table: name, icon, enabled, order), attached to tasks,
  knowledge, projects and conversations as an optional `domain_id`. Not separate apps or tabs.
- **Cross-scope knowledge** (using personal notes inside a business chat) is **not** automatic. A later, explicit
  "bring from Personal" action would copy or reference with consent. This avoids leaks between scopes.
- **Deletion/export:** the personal organization is deleted with the account; export uses the existing org data paths.
- **Migration:** additive (new column/flag + backfill job, no change to existing rows' ownership). Rollback: hide the
  personal org; no data moves.
- **Open question for the owner:** default domain list, and whether the personal org may invite others (recommend no).

### ADR-2 Memory and context

Keep `memory_records` (private by default) + the M2 ledger. Add measurement first (per-run tokens, ledger hits,
provider calls, latency, written to `agent_runs`/`run_events` and summarised in a docs report), then compaction:
older turns summarised with message-id provenance, bounded history by tokens instead of 20 messages. Never drop the
system policy, approvals, or fresh tool results.

### ADR-3 Knowledge graph

Server-side paging and neighbourhood loading (`/knowledge/graph?focus=&depth=&cursor=`) instead of one 150-node
snapshot; the client merges pages. Positions keyed by **org + user + view**, cleared on sign-out. Side panel on
widths ≥ 840 dp, bottom sheet on phones.

### ADR-4 File retrieval and artifacts

`drive.search` gains `kind` (image, document, …) → Drive `mimeType` filter, `orderBy` `createdTime|modifiedTime`
(stated in the answer), and `pageToken`. A new `drive.fetch` copies one file (≤ 10 MB, images ≤ 5 MB, thumbnail first
when available) into Qline storage as a `files` row, so it reuses the permission-checked `/files/:id/content` and
`ChatImage`. A new `file` artifact (name, MIME, size, source link) with a real open/download action; sent-message
attachment chips get the same action. Nothing is ever made public on Drive.

### ADR-5 Custom agents and AI customization

Custom agents reuse `agents`/`agent_versions`: add template `custom` with a required `base_template` that sets the
policy floor (tools can only be narrowed), drop the one-per-template uniqueness for `custom` only (partial unique
index), add revert, model, memory scopes and per-agent budgets. AI customization uses **typed proposals**
(`missions.propose`, `workflows.propose`, `agents.propose`, `settings.propose`) stored as drafts with a diff, reviewed
in the existing screens; applying goes through the same human routes and audit. Security, billing, secrets, ownership
and destructive actions are never proposable.

### ADR-6 Gemini keys and routing

New table `ai_provider_key_aliases` (id, org, provider, alias, ciphertext, hint, enabled, status, cooldown_until,
last_used_at, counters); the current single key becomes the first alias (backward compatible read path).
`agent_versions.key_alias_id` optional. Routing: explicit assignment → else least-recently-used among enabled,
healthy keys not cooling down, chosen with `for update skip locked`; on 429/RESOURCE_EXHAUSTED cool down that key and
fail over at most once; 401/403 → needs attention, never retried. Record the alias id on each run, never the secret.
No claim that more keys raise provider quotas.

## D. Phased plan

Each phase is one focused branch + PR, its own tests, and no merge/deploy without owner authorization.

| Phase | Scope | Why this order | Main risks |
|---|---|---|---|
| **1 (next)** | M1 remainder: OAuth `postForm` + identity timeouts and status checks; single-flight refresh (per-connection advisory lock); only `invalid_grant` marks a connection expired; streaming upload limits (byte-counting body reader before `formData`); parser time/row/decompressed-size bounds; docs corrections (README, docs/10 T5/T9, integration-setup, dated known limitations) | Safety and correctness gaps in existing paths; small, testable | Upload changes on Neon Functions' body handling (verify platform limit) |
| 2 | Auth/session: shared rate limiting (database storage), session list + revoke-all; impact analysis for hashed session tokens and session lifetime (docs/15) before any change | Needs owner decision on session policy and an email provider for password reset | Signing users out by mistake; email provider cost |
| 3 | Small UX gaps: attachment open/download + `file` artifact, graph positions per user, predictive Back flag, draft persistence, M2 measurement report | Cheap fixes to shipped features | Low |
| 4 | M10 key aliases + routing, then M9 custom agents (shared agent configuration) | Both touch agent config; keys first so agents can be assigned one | Concurrency of routing; migration of the single-key table |
| 5 | M7 Drive retrieval (search filters, fetch, inline images, file cards) | Builds on phase 3 artifacts | Restricted-scope verification for public users |
| 6 | M8 typed proposals (missions first) | Reuses setup/mission-plan proposal UI | Permission bypass — every apply goes through human routes |
| 7 | ADR-1 personal organization + domains, then M11 individual-first onboarding | Largest product change; needs the owner's ADR approval | Backfill for existing users; keeping business flows intact |
| 8 | M6 voice 2.0 (state machine, adaptive endpointing, barge-in, streaming TTS) | Needs provider/cost decision and device testing | Paid realtime providers; device-only behaviour |

M12 items run inside every phase; physical-device QA is required before calling any phase done.

## E. Owner decisions and actions

1. Approve or change **ADR-1** (personal default organization + domains) before phase 7.
2. Session policy (docs/15) and whether to add an email provider for password reset / verification (cost to be
   checked before choosing).
3. Voice provider direction for M6 (platform STT + server TTS vs. a paid realtime API) — cost estimate first.
4. A Google test account for Drive (M7) and confirmation of the GitHub App permissions in GitHub settings.
5. Physical-device QA of 1.7.0 (resume, graph gestures, knowledge sheet, Back, voice).
6. Neon branch cleanup (`preview-v1-7`, `preview-v1-6`, older previews and restore points) when you are ready.
