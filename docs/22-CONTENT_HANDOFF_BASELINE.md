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

## H. Owner actions (later, not in this task)

- Arrange the Drive folders, then map them in Qline (setup screen, run 6).
- Decide whether Qline may create its own handoff folder (`drive.file` write path, ADR-C3 point 2).
- Connect Google with a test user that is listed on the OAuth consent screen (`drive.readonly` is restricted; Testing mode).
- Choose the external editor and approve which asset folders it can see.
- Authorize merge, production migrations, deploy and an APK separately.
