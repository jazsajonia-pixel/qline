# 22 — Content Command Center: Drive handoff baseline, ADRs and 7-run plan

Prepared 2026-11-19 (run 1 of 7, Slice 0). Source brief: "Qline — External AI Handoff, Drive Logs & Handoff Monitor"
(owner, 2026-11-19).

This run is documentation only:
- no feature code, migration or production change;
- no OAuth scope change;
- no real Google Drive call.

Every gap below was confirmed by reading the code on `main`.

## A. Checkpoint (verified 2026-11-19)

| Item | State | Evidence |
|---|---|---|
| Default branch | `main` at `d3ad089` (Merge #34), clean | `git log`, `git status` |
| Open PRs | none before this run | `gh pr list` |
| Main CI | green on `d3ad089` and `a36bfba` | `gh run list --branch main` |
| Latest release | Qline 1.8.0 (`v1.8.0`, `qline-1.8.0.apk`) | `gh release list` |
| Production API | 1.8.0, migrations through 0019 | docs/21, docs/releases/v1.8.0.md |
| Repo `AGENTS.md` | none; README, docs 00–21 | file listing |

## B. What already exists and will be reused

| Need | Existing code | Notes |
|---|---|---|
| Tenant isolation | Every table has `org_id`, with RLS `org_id = qline_org()` and an org-scoped transaction (`core/db.ts` `withTenant`). Personal space = an org with `settings.kind='personal'` (migration 0019, `modules/orgs.ts`). | New tables follow the same pattern: `org_id` + `workspace_id`, policy `tenant_isolation`, grants via `9999_app_role.sql`. |
| Google connection | `integration_connections`: one per (org, provider), sealed tokens, `settings`/`cursor` jsonb, `last_sync_at`. `accessToken()` refreshes single-flight (phase 1). Dead grant → `expired`; temporary failure → 503. | Reused as-is. Content config gets its own table rather than overloading `settings`. |
| Drive scopes | `FEATURE_SCOPES.drive = drive.readonly + drive.file` (`integrations/oauth.ts:27`) | See ADR-C3. No change planned. |
| Drive client | `driveSearch`, `driveMeta`, `driveDownload` (streamed, size caps), `driveCreate`, `driveUpdate` (`integrations/connectors.ts:48-227`). 20 s timeouts. | `driveFields` lacks `parents`, `md5Checksum`, `sha256Checksum`, `version`, `headRevisionId`, `videoMediaMetadata`, `imageMediaMetadata`, `shortcutDetails`, `trashed`. Needs a list-children and changes client. |
| Durable jobs | `jobs` table with leases, fencing, retries + jittered backoff (`backoffMs`), dead letter, cancellation, idempotency key unique per (org, kind, key) (`runtime/jobs.ts`, migration 0007). | Sync, ingest and verify run as job kinds `content.*`. |
| Periodic tick | `/internal/tick/:key` (Neon cron) runs outbox relay, scheduled workflows, `runDueSyncs`, drain and reconcile (`modules/system.ts:96-118`). | Add one idempotent `content` reconciliation step. |
| Audit | Hash-chained `audit_events`; the app role cannot update or delete (`9999_app_role.sql`) (`core/audit.ts`). | Every Qline state change is audited. External input never writes audit rows directly. |
| Notifications | `notifications` table (`category`, `ref` jsonb), mobile `screens/notifications.dart` | **No dedupe key**: needs a `dedupe_key` + unique index (gap). |
| File storage | `files` + `putObject`/`getObject` (Neon storage), download route with nosniff and audit (`modules/files.ts`) | Manifest, PDF and ack exports are stored here and downloadable even when Drive writes are unavailable. |
| Strict schemas | `zod` is used across the API | Manifest, result and event schemas are zod `strict()` with length caps. |
| PDF | Only `unpdf`, which parses PDFs. **There is no PDF writer.** | Gap. See ADR-C8. |
| Missions / Command Center | `missions` (planning → … → completed), CEO template `ceo` named "AI CEO" (`modules/templates.ts:5`). Mobile copy says "AI CEO" (`missions.dart`, `home.dart:65`, `settings.dart:50`, `proposals.dart`). | Missions are model-run plans. An external handoff is a different lifecycle (ADR-C7). |
| Public routes | `oauthPublicRoutes`, `googleSignInRoutes` are mounted before `requireUser` (`app.ts:86-92`) | A Drive webhook route can be mounted the same way, with channel-token verification. |

## C. Gap matrix (brief → current code)

| # | Requirement | Status | Gap |
|---|---|---|---|
| 1 | Root folder + logical role mapping by ID | MISSING | No table or route. Drive tools search the whole Drive. |
| 2 | Recursive indexing of approved descendants only, paginated | MISSING | `driveSearch` is a global `q` search (max 25 per page). No `'<id>' in parents` walk. |
| 3 | Descendant validation, shortcut exclusion | MISSING | `parents` is not requested in `driveFields`. |
| 4 | Asset metadata (checksum, version, dimensions, duration) | MISSING | Not requested. No asset table. |
| 5 | Stable per-job ID + versioned manifest | MISSING | — |
| 6 | Editor instructions PDF | MISSING | No PDF writer. |
| 7 | Strict `result.json` / event schemas and idempotent ingestion | MISSING | — |
| 8 | Independent output verification in Ready for QA | MISSING | — |
| 9 | Qline-owned acknowledgement | MISSING | The DB ack is easy. A Drive copy depends on ADR-C3. |
| 10 | Separate external vs Qline state | MISSING | — |
| 11 | Drive change notifications, channel renewal, cursors | MISSING | No `changes.watch`, start page token or webhook route. |
| 12 | Reconciliation poll | PARTIAL | The tick exists. No content step. |
| 13 | Deduplicated notifications | PARTIAL | The table exists, with no dedupe key. |
| 14 | QA mission exactly once after verification | MISSING | `enqueue` idempotency keys can enforce it. |
| 15 | Handoff Monitor UI + setup screen | MISSING | — |
| 16 | "Command Center" label | MISSING | Visible text still says "AI CEO". |
| 17 | Works in a personal space | READY | Personal spaces are orgs. No business-only gate is needed. |

## D. Architecture decisions

### ADR-C1 — Folder mapping by Drive ID, validated against one root

Proposed:
- Table `content_drive_config`, one row per (org, workspace). It holds:
  - `root_folder_id`;
  - `roles` jsonb (`role → folderId`);
  - `validated_at`, `validation` (per-role result) and `status` (`unconfigured`, `valid`, `invalid`, `needs_revalidation`).
- Roles:
  - `root` (required);
  - `assets` (one or more folders, read-only);
  - `incoming` (Qline job packages);
  - `external_reports`;
  - `ready_for_qa` (required for verification);
  - optional `acknowledged`, `completed`, `failed`, `logs`.
- Validation walks each folder's `parents` chain with `files.get` until it reaches the root. It stops at a depth limit of 20 and rejects:
  - trashed folders;
  - non-folders;
  - shortcuts;
  - folders in a different shared drive than the root;
  - any folder whose chain does not reach the root.
- Changing the mapping sets `needs_revalidation`. Nothing is indexed or verified until validation passes.
- Indexing lists children with `'<folderId>' in parents and trashed = false`, paginated (`pageSize` 100), breadth-first. It is bounded by depth (8), total items (5,000 per sync) and concurrency (2).
- Shortcuts (`application/vnd.google-apps.shortcut`) are recorded as skipped and never followed.
- The allowlist is never widened implicitly.

Alternatives rejected:
- Folder names or paths: they change, and names are ambiguous.
- Whole-Drive search filtered afterwards: it reads outside the boundary.

### ADR-C2 — Trust boundary and state ownership

- **Qline's database is authoritative.**
  - `content_jobs` holds the Qline lifecycle state and, separately, the last external-reported status.
  - `content_job_events` is the event ledger, with unique `(org_id, job_id, source, event_key)`, so duplicates collapse.
  - Out-of-order events are stored with `occurred_at` and `sequence`. State is derived from the highest valid state, never from arrival order.
  - `content_job_acks` holds Qline's acknowledgement.
  - Every state change is written to `audit_events`.
- **External files are untrusted data.** They:
  - are parsed with strict zod schemas (size cap 256 KB, string and array caps);
  - never reach a model prompt as instructions;
  - are rendered as plain text in the app.

  A `completed` claim moves the job to `result_received`, then `validating_output`. Only Qline's own `files.get` checks move it to `output_verified` / `awaiting_video_qa`:
  - the parent is exactly the `ready_for_qa` folder ID;
  - the MIME type is `video/*`;
  - the size is within bounds;
  - the file is not trashed;
  - the name matches;
  - the checksum matches when one is supplied.
- **Folder location is never state.** Moving files between Incoming, Acknowledged, Completed and Failed is optional convenience. It can only happen if the write capability exists (ADR-C3).
- **Correlation:** the `job_id` plus a random `nonce` in the manifest correlate reports. They do not authenticate the editor. The UI and docs say so.

### ADR-C3 — OAuth scopes: no broadening; DB-first acknowledgement

The Google connection requests:
- `drive.readonly`, a restricted scope. It reads and lists any file the account can open. Google's Drive v3 discovery document (checked 2026-11-19) lists `drive.readonly` as accepted for `changes.getStartPageToken`, `changes.list`, `changes.watch`, `files.list` and `channels.stop`. It also confirms that the File fields `md5Checksum`, `sha256Checksum`, `version`, `headRevisionId`, `videoMediaMetadata`, `shortcutDetails`, `parents` and `capabilities` exist.
- `drive.file`, which is non-sensitive. It creates files and works on files Qline created or the user opened with Qline.

What is not verified:
- whether `drive.file` (even together with `drive.readonly`) lets Qline create a file inside a folder the user made outside Qline;
- whether Qline can move a user's files between lifecycle folders.

Google documents `drive.file` as "files that you open or create with an app". Neither has been tested with a live account.

Decision:
1. The authoritative manifest, PDF and acknowledgement live in Qline storage and the DB. They are downloadable from the job screen. This works with the current scopes.
2. A Drive copy of `manifest.json`, `editor-instructions.pdf` and `qline-ack.json` is written only when a capability check on the configured `incoming` folder passes. Otherwise the job shows "Upload these files to the handoff folder" with download buttons.
   - The supported write path that needs no scope change is a Qline-created folder (drive.file covers files Qline creates). Creating it is an explicit user action in setup and was not done in this task.
3. Qline never requests the full `drive` scope. Any broader scope needs owner approval and a reconnect.
4. **Folder-level write isolation cannot be enforced in Drive.** Permissions inherit downward and cannot be reduced on children. An editor with writer access to a job folder can also overwrite `input/` and `handoff/qline/`. Mitigation:
   - Qline records the Drive file ID, `md5Checksum`/`version` and its own SHA-256 for everything it writes;
   - any later change is a tamper finding;
   - the DB ack stays authoritative.

   The UI does not claim "read-only" for those folders.

### ADR-C4 — Change notifications plus reconciliation

- One `changes.watch` channel per Google connection with a mapped root, not one per folder. The channel ID is a random UUID; the channel token is a random secret stored only as a SHA-256 hash.
- Expiration is set to 7 days, the documented maximum. Channels renew when less than 24 h is left, so an expiring channel always has a replacement. The old channel is stopped after the new one is confirmed.
- Public route `POST /v1/hooks/drive`:
  1. checks `X-Goog-Channel-ID` + `X-Goog-Channel-Token` (constant-time hash compare);
  2. ignores `sync` messages;
  3. enqueues `content.drive_sync` with an idempotency key per (connection, 30 s bucket);
  4. returns 204.

  Bodies are always empty (Google docs), so Qline always re-reads with `changes.list`.
- `changes.list` starts from the stored page token. It keeps only files whose parent is a mapped folder, then advances and persists `newStartPageToken` in the same transaction as the processed changes.
  - On a 400/404/410 invalid-token error, Qline marks the cursor stale, rescans the mapped folders and takes a fresh start token.
- The tick runs `content.reconcile` for every configured workspace every 10 minutes (by `last_reconciled_at`). It:
  - covers missed webhooks;
  - flags jobs with no activity past their SLA as `stale`;
  - expires jobs past `expires_at`.
- Errors are explicit. 429 and 5xx retry with the existing jittered backoff; 401 with a dead grant shows "Reconnect Google"; 403/404 on a mapped folder shows "Folder access lost". Each is recorded on the config row (`last_error`, `last_success_at`).
- **The webhook is a fast signal only.** It can only work once the API's public HTTPS URL receives it. Live behaviour is unverified until the owner connects an account.

### ADR-C5 — Job ID

- Format: `QLINE-YYYYMMDD-xxxxxx` (UTC date plus 6 lowercase Crockford base32 characters from `crypto.randomBytes`).
- Unique per org (`unique(org_id, job_code)`), alongside the internal UUID primary key.
- The same code is used in the PDF, manifest, result, output file name hint, QA mission and later publication records.

### ADR-C6 — "Command Center" label

- Display-only rename. The template key stays `ceo`, so the policy, tools, `T('ceo')` and agent versions are untouched.
- A migration renames built-in `ceo` agents only when the name is still the default `'AI CEO'`. Names the user changed are kept.
- Mobile copy changes from "AI CEO" to "Command Center".

### ADR-C7 — Content jobs are their own lifecycle, linked to missions

- `content_jobs` has an optional `mission_id`, so a Command Center mission can own several jobs. Missions keep their existing states.
- Qline states:
  - `prepared`
  - `dispatched` (waiting for the external acknowledgement)
  - `external_acknowledged`
  - `external_in_progress`
  - `result_received`
  - `validating_output`
  - `output_verified`
  - `awaiting_video_qa`
  - `needs_manual_review`
  - `failed`
  - `blocked`
  - `expired`
  - `cancelled`
- External statuses: `accepted`, `in_progress`, `completed`, `failed`, `blocked`, `cancelled`.
- The video QA step is created at most once per job. It uses idempotency key `content_qa:<job_id>` on `enqueue` and a unique `qa_mission_id` column. Approving the video is a separate later gate. Nothing is published.

### ADR-C8 — Editor instructions PDF

There is no PDF writer in the repo. Proposed: a small internal text-PDF writer (`core/pdf.ts`):
- standard Helvetica;
- WinAnsi text with unsupported characters replaced;
- automatic page breaks.

This is preferred over a new dependency because the PDF is only structured text (job ID, constraints, exact asset list, return instructions). `pdf-lib` (MIT) is the fallback if fonts or Unicode coverage become necessary. It is free, but adds bundle size. The decision and its test are made in run 3.

## E. Minimal schema (migrations from 0020; not yet written)

- **`content_drive_config`:**
  - org_id, workspace_id (unique together), connection_id;
  - root_folder_id, roles jsonb, status, validation jsonb, validated_at;
  - change cursor: start_page_token, cursor_status;
  - watch channel: channel_id, channel_token_hash, resource_id, channel_expires_at, channel_renewed_at;
  - last_success_at, last_error, last_reconciled_at.
- **`content_assets`:**
  - org_id, workspace_id, drive_file_id (unique per workspace), name, mime, parent_id, role;
  - size_bytes, md5, version, created_at_drive, modified_at_drive;
  - width, height, duration_ms, web_view_link;
  - state (`indexed`, `skipped_shortcut`, `outside_root`, `removed`), last_seen_at.
- **`content_jobs`:**
  - id, org_id, workspace_id, job_code (unique per org), mission_id, title, editor_target;
  - qline_state, external_status, nonce;
  - manifest jsonb, manifest_sha256, manifest_file_id, pdf_file_id;
  - drive_package (Drive ids written, with checksums);
  - expected_outputs jsonb, constraints jsonb;
  - created/dispatched/last_activity/result_received/verified/expires_at;
  - qa_mission_id unique, revision, created_by.
- **`content_job_events`:**
  - org_id, job_id;
  - source (`qline`, `external`, `drive`), event_key (unique per job and source);
  - sequence, occurred_at, received_at, event_type, message (clipped);
  - file_ids text[], raw_sha256.
- **`content_job_outputs`:**
  - org_id, job_id, drive_file_id (unique per job);
  - name, mime, size_bytes, md5, parent_id, web_view_link;
  - verification (`verified`, `rejected`) with findings jsonb, verified_at.
- **`content_job_acks`:**
  - org_id, job_id, version;
  - status (`accepted`, `rejected`), findings jsonb, verified_output_ids;
  - validation_version, correlation_id, drive_file_id (when written), sha256.
- **`notifications`:** add `dedupe_key` with a unique partial index on (org_id, user_id, dedupe_key).

All new tables get RLS `tenant_isolation`. `content_job_events` and `content_job_acks` are append-only for `qline_app` (revoke update/delete, like `audit_events`).

## F. API (planned)

- `GET` / `PUT /content/drive-config`
- `POST /content/drive-config/validate`
- `POST /content/sync` (manual "Sync now")
- `GET /content/assets?role=&q=`
- `POST /content/jobs` (from selected asset IDs, constraints and editor target)
- `GET /content/jobs?filter=active|awaiting|completed|failed|attention`
- `GET /content/jobs/:id` (detail with timeline, outputs, ack, findings)
- `GET /content/jobs/:id/manifest`
- `GET /content/jobs/:id/pdf`
- `GET /content/jobs/:id/ack`
- `POST /content/jobs/:id/ingest` (manual paste or upload of `result.json`, validated identically to the Drive path)
- `POST /content/jobs/:id/reconcile`
- `POST /content/jobs/:id/reissue` (new revision, same job code, revision++)
- `POST /content/jobs/:id/cancel` (with confirmation)
- `POST /v1/hooks/drive` (public, channel-token check)

## G. Seven-run plan

One feature branch, `content/drive-handoff`, with a draft PR. **It is not merged.** There is no production migration, deploy, scope change, Drive write or APK without separate owner authorization.

| Run | Slice | Deliverable | Gate (must pass to tick) |
|---|---|---|---|
| 1 | 0 | This document: gap matrix, ADRs C1–C8, plan; KB plan note | Doc reviewed against the code; draft PR open |
| 2 | 1 | Migration 0020 (config, assets); folder mapping API; descendant validation; recursive paginated indexing; `driveFields` extended; manual Sync now | Integration tests (mocked Drive): pagination, boundary rejection, shortcuts, revoked access (403/404/401), cross-org isolation, no write calls |
| 3 | 2a | Migration 0021 (jobs, events, outputs, acks, notifications dedupe); job code; manifest schema + builder from indexed assets only; PDF writer; Command Center rename (ADR-C6); create/list/detail/cancel/reissue routes | Tests: manifest contains only indexed in-root assets; job code uniqueness; PDF parses with `unpdf`; rename leaves custom names |
| 4 | 2b | `result.json` + event schemas; ingestion (Drive and manual); output verification; ack (DB, Drive copy only if capability); deduped notifications; QA step exactly once | Tests: valid/invalid/unsupported versions, mismatched IDs, fake completion, output outside Ready for QA, duplicate/out-of-order/replayed events, malicious strings, oversize payloads, tamper detection |
| 5 | 3 | Changes cursor, `changes.watch` + renewal + stop, webhook route, reconciliation tick step, stale cursor rescan, backoff, leases | Tests: expired channel, stale cursor, missed webhook found by tick, 429/5xx, crash mid-sync (lease reclaim) with no duplicate events, QA step or notifications |
| 6 | 4 | Mobile: Content Studio under Command Center, folder setup screen, Handoff Monitor list + filters, job detail (two state labels, timeline, inputs, outputs, findings, safe actions), notifications deep links | Widget tests (empty/loading/error/stale/permission/offline, 390 px, light/dark, semantics); screenshots |
| 7 | 5 | Docs (09 integrations, external editor handoff spec with exact examples, setup, API examples, release notes draft); full diff review; full CI; PR description with verified / unverified lists | CI green; PR ready for review (not merged) |

### Progress

- **Run 1 (Slice 0), 2026-11-19:** this document. Docs only.
- **Run 2 (Slice 1), 2026-11-20:** built, tested with a mocked Drive only.
  - Migration `0020_content_drive.sql`: `content_drive_config` (including the run-5 cursor and channel columns) and `content_assets`, both with RLS `tenant_isolation`.
  - `services/api/src/modules/content.ts`: `GET`/`PUT /content/drive-config`, `POST /content/drive-config/validate`, `POST /content/sync`, `GET /content/assets`.
  - `driveFields` now also asks for `parents`, `trashed`, `driveId`, checksums, `version`, `headRevisionId` and video/image metadata; new read-only `driveChildren`.
  - Decisions made in this run:
    - A role folder cannot be the root, and one folder cannot have two roles (400).
    - Required roles: `assets` (1–10 folders) and `ready_for_qa`.
    - Changing the mapping marks every indexed asset `removed` and needs validation again. Switching the Google account also needs validation again.
    - Missing files are marked `removed` only after a complete listing (not after a truncated or failed one).
    - Sync now runs inline in the request with no automatic retry. Run 5 moves it to a durable job with backoff.
  - Tests: `services/api/test/content-drive.integration.test.ts` (12 tests). Not verified with a real Google account.
- **Run 3 (Slice 2a), 2026-11-20:** built, tested locally against Postgres with a mocked Drive (used only to index assets). Nothing is written to Drive.
  - Migration `0021_content_jobs.sql`: `content_jobs`, `content_job_events`, `content_job_outputs`, `content_job_acks` (RLS `tenant_isolation`), plus `notifications.dedupe_key` with a unique partial index. `9999_app_role.sql`: the app role cannot update or delete events and acks, or delete jobs.
  - Migration `0022_command_center_label.sql`: built-in `ceo` agents still named `AI CEO` become `Command Center`; custom names are kept. New organizations get `Command Center`. Mobile and API messages now say Command Center. The template key stays `ceo`.
  - `core/pdf.ts`: internal text-PDF writer (Helvetica, Helvetica-Bold, Courier; WinAnsi; wrapping; page breaks; no dates, so the same input gives the same bytes).
  - `modules/content-jobs.ts`: `POST /content/jobs`, `GET /content/jobs?filter=`, `GET /content/jobs/:id` (with events, outputs, acks), `GET …/manifest`, `GET …/pdf`, `POST …/cancel` (needs `confirm: true`), `POST …/reissue` (needs the current `revision`).
  - Job code `QLINE-YYYYMMDD-xxxxxx` (6 lowercase Crockford base32 characters), unique per organization, retried on a clash.
  - Manifest schema `qline.content.manifest/1`; result schema `qline.content.result/1` (shown in the manifest and PDF as `resultExample`; run 4 must accept exactly this). Expected output name `<code>-r<revision>.mp4`, result file `<code>-r<revision>.result.json`.
  - Deviations from §E, decided in this run:
    - The manifest is stored as the exact issued JSON text (`manifest_json text`), not `jsonb`, so its SHA-256 can always be re-checked. The PDF bytes are stored in the row (`pdf bytea`). There is no `manifest_file_id` / `pdf_file_id`, because nothing is uploaded in this slice. Downloads re-check both checksums and refuse a mismatch (500 `INTEGRITY_FAILED`).
    - List filters are `active | awaiting | failed | attention | all`. There is no `completed` filter yet, because no terminal success state exists until the QA gate in run 4/5.
    - Inputs must be `indexed` files from an `assets` role folder. Files in Ready for QA, removed files, shortcuts and unknown IDs are refused (400, listing the IDs).
    - Reissue is refused from `cancelled`, `output_verified` and `awaiting_video_qa`. Cancel is refused from `cancelled` and `expired`.
    - The `ceo` template's instructions still start "You are the AI CEO…". Changing them would change model behaviour, so it is left for Jazz to decide.
  - Tests: `services/api/test/content-jobs.integration.test.ts` (15 tests) and `services/api/test/pdf.test.ts` (3 tests). PDFs are parsed with `unpdf`, which needs Node 22+ (CI uses 24).
- **Run 4 (Slice 2b), 2026-11-20:** built, tested locally against Postgres with a mocked Drive. Read-only Drive only (files.list, files.get, alt=media); nothing is written to Drive.
  - Migration `0023_content_reports.sql`: `content_jobs.qa_mission_id` renamed to `qa_task_id`; adds `content_jobs.last_error`, `content_job_outputs.version`, `content_job_acks.report_sha256`, `content_drive_config.last_reports_check_at` / `last_reports_check`.
  - `modules/content-reports.ts`:
    - `POST /content/jobs/:id/ingest` (raw `result.json` as the body, max 256 KB),
    - `POST /content/reports/check` (reads `<code>-r<rev>.result.json` files from the Reports folder; each Drive version is read once; then checks verified outputs for tampering),
    - `POST /content/jobs/:id/verify` (retries a check that Drive could not finish),
    - `GET /content/jobs/:id/ack[?version=]` (acknowledgement `qline.content.ack/1`, SHA-256 re-checked).
  - Report handling:
    - Strict `qline.content.result/1` schema. Control and bidi characters are stripped. Findings for invalid JSON, invalid shape, unsupported schema, invalid or unknown fields, not UTF-8 and too large. A different job, an old or unknown revision, the wrong nonce (constant-time compare), or a closed or expired job are all rejected.
    - Every report is an event. Exact replays collapse. A second report claiming a used `sequence` is rejected (`sequence_conflict`).
    - `external_status` and the Qline state follow the strongest report of the current revision (status rank, then sequence, then time), never arrival order. Reports arriving while a job is being checked, verified, in review, cancelled or expired are recorded only.
    - External `failed`/`blocked` set those states. An external `cancelled` goes to `needs_manual_review`; only Qline cancels.
  - Output verification uses Qline's own files.get. The output must:
    - be directly and only in Ready for QA;
    - be a `video/*` file of 1 byte to 20 GB;
    - not be trashed or a shortcut;
    - not be a source file;
    - have the same name as in the report, and the expected `<code>-r<rev>.mp4` must be present;
    - match the reported MD5 and size, when the report gives them.

    Source files must also be unchanged (MD5 and size) and not trashed. Any finding → `needs_manual_review`. All clear → `output_verified` → `awaiting_video_qa`. Drive trouble (429/5xx/401/network) leaves the job in `validating_output` with `last_error`.
  - Acknowledgements are stored in the DB only, one per decision (rejected reports, terminal reports, every completed check). No Drive copy: the ADR-C3 capability check was not run, because Drive writes are not authorized.
  - Notifications go to the job creator plus owners and admins, deduplicated by `content:<job>:<event>`. Their text is Qline's own; report text never appears in notifications or tasks.
  - Deviation from ADR-C7: the QA step is a human **task** (`tasks`, source `content_job:<id>`, assigned to the creator), not a mission. Missions start model planning, and report text must never reach a model. It is created at most once per job: `qa_task_id` is set under the job row lock.
  - Tamper on outputs: during "Check reports", verified outputs that were renamed, moved, trashed, changed or became unopenable are recorded once (`output.tampered`, source `drive`), and the job goes to `needs_manual_review` with one notification.
  - Limits and known gaps: 50 reports and 200 verified outputs per check, 10 list pages. An exact duplicate report under a different Drive file is downloaded again on every check (bounded by the 50 limit). Expiry and stale sweeps are run 5.
  - Tests: `services/api/test/content-reports.integration.test.ts` (15 tests).
- **Run 5 (Slice 3), 2026-11-20:** built and tested locally against Postgres with a mocked Drive. The only Drive calls added are changes.getStartPageToken, changes.list, changes.watch and channels.stop. No file is written to Drive and the OAuth scopes are unchanged.
  - Migration `0024_content_watch.sql`:
    - `content_drive_config` gains `folder_index`, a sync lease (`sync_lease_owner` / `sync_lease_until`), the previous channel (`prev_channel_*`), `cursor_reset_at` and `last_reconcile`, plus unique partial indexes on `channel_id` and `prev_channel_id`;
    - `content_jobs.stale_since`;
    - security-definer functions `qline_content_due(lim)` (workspaces not reconciled for 10 min) and `qline_content_channel(cid)` (channel → workspace and token hash; never a token).
  - `modules/content-watch.ts`, with jobs `content.drive_sync` and `content.reconcile`:
    - The first sync is a full listing that takes the start token first, so nothing is missed. After that, changes.list runs page by page (100 per page, up to 20 pages per run; a follow-up job carries on). The cursor is saved per page with a compare-and-swap, under the lease and the validated-config check. Only files inside the mapped folders are applied.
    - Folder changes inside the tree cause a re-listing. A change to the root or a mapped folder re-checks the boundary, which also catches a QA folder being moved.
    - A stale cursor (400/404/410) leads to a full listing and a fresh token.
    - 429, 5xx, 403 and network errors are retried with the runtime's backoff and recorded in `last_error`. A refused sign-in or lost access marks the config and stops. A superseded or not-valid config is skipped.
    - The sync lease lasts 90 s and is renewed per page. A crash leaves the lease to run out, and the next run resumes from the saved cursor. Assets are upserted, so a replay creates no duplicates.
    - When anything changed, and on every reconcile, the run-4 Reports check runs (each report version is read once). On reconcile, verifications that Drive could not finish (`validating_output` with `last_error`) are retried.
  - Reconciliation runs from the system tick (`runContentReconcile`) for workspaces not reconciled for 10 minutes. The cycle is claimed with a compare-and-swap on `last_reconciled_at`, so racing ticks queue one job. It runs the sweeps, the sync and the channel upkeep.
  - Sweeps:
    - Jobs past `expires_at` in an open state go to `expired`, with a notification.
    - Jobs with no activity for 72 h in prepared/dispatched/acknowledged/in-progress are flagged once per quiet period (`stale_since`, a `job.stale` event and a notification). `GET` job responses now include `stale` and `staleSince`.
  - Push channel (`ensureChannel`), off unless `QLINE_DRIVE_WEBHOOK_URL` is set (HTTPS only, otherwise ignored):
    - It opens a changes channel for 7 days (the documented maximum) with a random token, of which only the hash is stored.
    - It renews when less than 24 h is left. The pending channel is stored before the watch call, so an early `sync` message is accepted. The old channel stays valid as `prev_*` until the new one is confirmed, and is then stopped. If the stop fails, it is retried on the next tick. If the watch fails, the old channel is restored.
    - When the URL is unset or the config is not valid, the channels are stopped and cleared.
  - `POST /v1/hooks/drive` takes no session; it is mounted before `requireUser`:
    - Unknown channels, a wrong token (constant-time compare), a wrong resource or an expired channel return 404, so Google stops sending.
    - `sync` messages return 204.
    - Otherwise it queues one `content.drive_sync` per workspace per 30 s (idempotency key), kicks the runtime and returns 204. Message content is never trusted; the sync reads Drive itself.
  - Deviations:
    - Manual "Sync now" (`POST /content/sync`) stays inline. It now takes the lease (409 `SYNC_BUSY` when a sync is running) and resets the cursor.
    - A 403 on changes.list is treated as a rate limit (Drive uses 403 for some quota errors).
    - There is no `/content/jobs/:id/reconcile` route; the tick covers it.
    - The stale threshold is a fixed 72 h, not per job.
    - Tamper checks still need a Reports folder to be mapped.
  - Not verified: live Google push (needs a public HTTPS domain with a valid certificate, `QLINE_DRIVE_WEBHOOK_URL` and a real account), real Drive change ordering and quota behaviour.
  - Tests: `services/api/test/content-watch.integration.test.ts` (10 tests). They cover paging, folder moves, stale cursor, missed webhook, 429/5xx/401, crash mid-sync, webhook checks, renewal, sweeps and tenant isolation.
- **Run 6 (Slice 4), 2026-11-20:** mobile screens, tested with widget tests against a mocked API. No server change, no Drive write, no scope change.
  - Home → Command Center now holds two cards: Missions and Content Studio. "Command Center" is a label only; the `ceo` key is unchanged.
  - `lib/screens/content.dart`:
    - Content Studio: Drive status card (opens setup), "Check Drive for reports" (members and up, when a Reports folder is mapped), Handoff Monitor with the server filters (active, awaiting, attention, failed, all), New handoff (members and up, when folders are valid).
    - New handoff: title, brief, shape (any, 9:16, 16:9, 1:1, 4:5) and up to 50 indexed source files.
    - Job detail: the "Qline checked" and "Editor says" ledgers are shown apart, with the note that editor reports are untrusted until Qline checks the video. Notes for stale, last error, cancel reason and a failed manifest checksum ("don't send, reissue"). Editor PDF and manifest download, "Open review task" when waiting for review, "Check the video again" for deferred checks, paste a result file (sent as the raw body, so it is validated like a Drive file), reissue and cancel (both confirmed). Editor messages in the timeline are quoted as "Editor wrote".
    - A 404 on the content routes shows "Content Studio is not on your server yet" (production API 1.8.0 has no content routes).
  - `lib/screens/content_setup.dart`: folder setup accepts Drive links or IDs, saves then checks, offers Sync now when valid, shows the last check in plain words and is read-only for non-managers. Folders not on the main form are kept on save.
  - Deep links: notifications with `ref.kind = content_job` open the job from the in-app list and from Android notification taps (payload on `show`, tap handler and launch details).
  - Deviations: New handoff has no duration, notes or expiry fields (server defaults apply). The asset picker shows the first 100 files without search.
  - Not verified: a real phone, the system-tray tap path (not unit-testable), the live server (it lacks the content routes until a deploy is authorized).
  - Tests: `apps/mobile/test/v17_content_test.dart` (29 tests): loading, empty, error, offline, older server, stale, viewer and member permissions, semantics, 390 px light and dark screenshots, 130% text.
- **Run 7 (Slice 5), 2026-11-20:** editor spec, docs, final audit, v1.9.0. No Drive write, no scope change, no production deploy or migration.
  - New [docs/23](23-EDITOR_HANDOFF_SPEC.md): the editor's side (manifest, result file, names, refusals, checks, receipt). Route table in docs/06 §6, Drive section in docs/09, setup in integration-setup §7.
  - Audit of section C: every row is implemented. By design (ADR-C3) Qline does not put the manifest, PDF or receipt into Drive; the owner sends them. Live Drive push is built but untested (needs a public HTTPS webhook).
  - Gap fixed: the job screen can now save Qline's receipt (`/content/jobs/:id/ack`) as `<code>-r<rev>.ack-<ver>.json`; one widget test added (30 in v17).
  - Known limit: there is no "mark as sent" action, so `dispatched` is never reached; a first accepted report moves a job from `prepared` straight on.
  - Versions: app 1.9.0+11, API_VERSION 1.9.0. Production stays on API 1.8.0 until the owner authorizes the deploy and migrations 0020–0024; until then the app shows "not on your server yet".
  - Not verified: a phone, a real Google account and editor, the live server.
- **Production rollout, 2026-11-20 (owner-authorized):** migrations 0020–0024 plus grants applied to `br-muddy-rain-a1uaplxr` in one transaction (rehearsed first on a fresh local database at 0019; the Neon branch and snapshot limits were full, so the rewind point is the recorded position `0/60369F8` at 03:19:14 UTC, within the history window). Function `api` deployment #15 (bundle SHA-256 `6e4b9449…4770c`, built from main `88aa2a7`, environment unchanged). Live `/v1/health` reports 1.9.0 and `/health/ready` is ok; content routes answer 401 without a session. CI smoke now expects 1.9.0.

## H. Owner actions (later, not in this task)

- Arrange the Drive folders, then map them in Qline (setup screen, run 6).
- Decide whether Qline may create its own handoff folder (`drive.file` write path, ADR-C3 point 2).
- Connect Google with a test user that is listed on the OAuth consent screen (`drive.readonly` is restricted; Testing mode).
- Choose the external editor and approve which asset folders it can see.
- Authorize merge, production migrations, deploy and an APK separately.
