# 15 — Session Security Recommendation

Status: **proposal only; not an approved authentication-policy change**  
Date: 2026-11-17  
Scope: Qline v1.4.0 post-release security follow-up

## 1. Executive finding

Qline currently uses Better Auth 1.7.25 with the bearer plugin and database-backed sessions. The current configuration is:

- `expiresIn: 60 * 60 * 24 * 30` — 30 days.
- `updateAge: 60 * 60 * 24` — Better Auth may extend the session expiry when the session is used and the update age has elapsed.
- No Better Auth cookie cache is configured.
- The bearer plugin exposes the session credential to the Flutter client.

This is a **single opaque bearer session credential with rolling expiry**, not a short-lived access-token plus rotating-refresh-token design. Better Auth documents that `updateAge` controls when expiry is extended; it does not rotate the session token. Do not describe this configuration as refresh-token rotation.

References:
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/docs/reference/options

## 2. Required account-level session controls

The security threat model (T12) requires users to see and revoke device sessions.

The account-scoped API proposal in this branch adds:

- `GET /v1/me/sessions`: list active sessions for the authenticated account.
- `DELETE /v1/me/sessions/:id`: revoke one of the authenticated account's sessions.
- Session bearer tokens are never returned by the Qline API.
- A session belonging to another account is indistinguishable from a nonexistent session (404).
- Responses use `Cache-Control: no-store`.

These controls are user/account scoped, not organization scoped. A user may belong to multiple organizations, so session security must not depend on the active organization header.

The implementation uses Better Auth's documented server APIs `listSessions` and `revokeSession`. The real-Postgres integration test must pass before this behavior is treated as verified.

## 3. Session lifetime options

### Option A — Fixed-duration interim policy

- Disable automatic session refresh.
- Set an explicit finite expiry (for example, 7 days).
- Require sign-in again when the fixed expiry is reached.
- Keep per-device revocation enabled.

Advantages: small implementation surface; gives a clear maximum lifetime for the bearer credential.

Trade-offs: no seamless refresh; users must periodically sign in again; it still is not refresh-token rotation. The exact duration is an owner decision and must be tested against mobile sign-in/session persistence.

### Option B — Rolling idle expiry

- Use a shorter configured `expiresIn` (for example, 7 days).
- Retain a deliberate `updateAge` for sliding renewal.
- Revoke sessions through the account session API.

Advantages: better mobile convenience after regular use.

Trade-offs: a frequently used or stolen credential can remain valid indefinitely; this does not establish a fixed absolute session lifetime and does not rotate the bearer token.

### Option C — Target architecture matching T12

Implement a distinct short-lived access credential and rotating refresh credential:

- Access credential lifetime measured in minutes (proposed 5–15 minutes).
- Refresh credential has a longer bounded lifetime (proposed 30 days).
- Every successful refresh atomically consumes the old refresh token and issues a new one.
- Store only a cryptographic hash of refresh tokens.
- Detect refresh-token reuse; revoke the affected token family and require re-authentication.
- Bind the refresh-token family to a device/session record.
- Preserve account-level list/revoke and revoke-all controls.
- Define logout, password-change, compromise, and concurrent-refresh behavior.
- Add integration tests for replay, race conditions, rotation, expiry, revocation and cross-account isolation.

This is the best match for the current threat-model wording, but it is a larger authentication change. It must be designed against Better Auth's existing bearer flow and Flutter secure storage before implementation.

## 4. Recommendation

**Do not change the current 30-day behavior in the session-management API patch.**

Recommended sequence:

1. Land and verify the account-scoped list/revoke API in isolation.
2. Owner chooses whether Option A is acceptable as a temporary policy or whether Qline should move directly to Option C.
3. If Option C is selected, write a separate architecture decision and migration/rollout plan before changing authentication.
4. Update T12 only after the selected design is implemented and tested. Do not weaken the threat model merely to match current behavior.

If an interim policy is needed, Option A is easier to reason about than a rolling 7-day expiry, but the exact duration requires owner approval.

## 5. Database verification gate

The previous coding run reported a local PostgreSQL 16 database named `qline_test`, migrated under a least-privilege `qline_app` role. That environment is not available to this follow-up session, so the report is not independently confirmed here.

Before claiming integration coverage:

- Verify `QLINE_TEST_ENV` points only to the disposable local database.
- Verify the database host/name and role; reject Neon production URLs.
- Run the complete migration set against the disposable database.
- Confirm `qline_app` is not a superuser, table owner, or `BYPASSRLS` role.
- Run API and runtime integration suites and retain the command output.

## 6. ExcelJS / uuid advisory triage

The lockfile resolves `exceljs@4.4.0` with transitive `uuid@8.3.2`. GitHub advisory GHSA-w5hq-g745-h8pq describes missing output-buffer bounds checks in the `v3`, `v5`, and `v6` APIs when callers supply a buffer. The advisory does not describe the ordinary `v4()` call path as affected.

Do not force an override based only on the audit warning. Confirm the exact ExcelJS UUID call sites and whether Qline can reach the vulnerable APIs. Then choose one of:
- a compatible patched UUID override with CommonJS/runtime and XLSX regression tests;
- an upstream ExcelJS fix when available; or
- a test-first replacement of ExcelJS if maintaining the dependency tree becomes more costly than the migration.

The lockfile also resolves `tmp@0.2.7`; verify the actual audit output before treating it as an additional finding.

Advisory: https://github.com/advisories/GHSA-w5hq-g745-h8pq

## 7. Release gate

No merge to `main`, production deployment, APK publication, or release recommendation follows from this proposal alone. Required gates remain:

- session API integration tests pass against disposable PostgreSQL;
- selected session-lifetime design is approved, implemented, and tested;
- dependency audit is re-run and findings are accurately classified;
- PR #10's mobile UI change and physical-device QA are complete;
- final CI and production smoke pass after explicit release approval.


## 8. Follow-up review and recommended session policy (2026-11-17)

### Recommended policy decision

**Recommend Option C as Qline's target policy; do not ship Option A or B as the long-term design.** T12 explicitly requires short-lived access plus refresh rotation. A seven-day fixed bearer session would reduce the current exposure window but would still not provide rotation, while a rolling seven-day bearer session can remain valid indefinitely when used.

Proposed target parameters for owner approval:
- Access credential: 10 minutes; validate issuer, audience, subject, session/device id, expiry and signing-key id.
- Refresh credential: opaque, single-use, cryptographically random, 30-day absolute lifetime and 7-day idle lifetime.
- Persist only a keyed hash of each refresh token; rotate atomically on every refresh.
- Detect reuse of a consumed token and revoke the entire token family; require sign-in again.
- Store the refresh credential in Android Keystore-backed secure storage; keep access credentials in memory where practical.
- Keep account-level session list/revoke and add revoke-all, password-change and compromise invalidation.
- Require fresh authentication for high-risk actions; rate-limit refresh and record security events without logging credentials.
- Define safe concurrent refresh behavior (client single-flight plus server-side atomic compare-and-swap); test races, replay, expiry, revocation, logout and recovery.

This is a **technical recommendation, not owner approval**. The current Better Auth 30-day rolling session remains unchanged until the owner approves the migration. Before implementation, spike the exact Better Auth 1.7.25 bearer/session integration and decide whether to retain Better Auth as identity/session registry or introduce a dedicated token-family table and middleware. Do not bolt a second refresh system onto the current bearer token without that design.

### UUID advisory reachability and remediation

The exact ExcelJS 4.4.0 source call site is `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`: it imports `require('uuid').v4` and calls `uuidv4()` with no output buffer or offset. Qline's own XLSX import path only loads workbooks and reads worksheet values. GHSA-w5hq-g745-h8pq affects the separate `v3()`, `v5()` and `v6()` APIs when a caller supplies an output buffer with an invalid size/offset; the inspected ExcelJS path does not invoke those APIs. This makes the specific vulnerable call pattern **not reachable through the inspected Qline/ExcelJS path**, but the old package version still creates an SCA finding.

A narrow compatibility remediation is being tested: npm override scoped to ExcelJS, `uuid@^11.1.1`. UUID 11.1.1 retains a CommonJS `require` export, unlike uuid 14's ESM-only package shape. Qline's existing XLSX parser unit test exercises the ExcelJS import/read path. CI now runs `npm audit --audit-level=moderate`; treat the override as verified only if clean install, audit, unit/integration tests and API build all pass on the resulting commit.

The lockfile also resolves `tmp@0.2.7`. This is above the patched version for CVE-2026-44705 (0.2.6) and CVE-2026-49982 (0.2.7); no tmp override is indicated by those advisories. The CI audit remains the source of truth for the full current dependency tree.

### Physical-device QA boundary

PR #10 (`qa/v1.4-stabilization`) changes the Approvals and Background jobs segmented filters. Its CI run 44039339567 passed Flutter analyze, tests and release APK compilation, but did not publish an APK artifact and is not a physical-device test. PR #11's run 44060012661 also passed the APK build, but it does not contain PR #10's mobile UI changes.

The physical-device gate must use a build of PR #10's exact head, not PR #11 or main. Install on the owner's Redmi Pad 2 (8 GB/256 GB) with a separate QA application id/signature so it does not overwrite the existing production installation. Verify Approvals and Background jobs filters at 320 dp / 200% text, touch/scroll behavior, navigation, light/dark theme, app resume, API loading/error/empty states, and no overflow or clipped labels. Capture device model, Android version, build SHA and screenshots. Do not mark this gate passed from widget tests or an APK compilation alone.

## 9. Verified behavior, Better Auth fit for Option C, and the owner decision (2026-11-17, Perplexity Computer)

### 9.1 Verified current behavior (PR #11)

Covered by `services/api/test/api.integration.test.ts` against disposable PostgreSQL 16 in CI (see the PR for the run ID on the final head):

| Behavior | Result |
| --- | --- |
| `GET /v1/me/sessions` lists only the caller's sessions, never the token, `Cache-Control: no-store` | Tested |
| Another account's session id → 404 on revoke; it never appears in the caller's list | Tested |
| Unauthenticated revoke → 401 | Tested |
| Malformed/oversized id (>128 chars) → 400; unknown id → 404 | Tested |
| Revoked session stops working on the next request (no cookie cache is configured, so every request reads the DB) | Tested |
| Concurrent revokes of one session → only 200/404, never 5xx; session ends revoked; repeat revoke → 404 | Tested |
| A user can revoke the session making the request | Tested |
| Expired session (row still present, `expiresAt` in the past) → 401 and disappears from the list | Tested |
| Concurrent *refresh* | Not applicable: the current design has no refresh credential. `updateAge` only extends `expiresAt`; the token never changes. |

Remaining limitations of the current design (unchanged by PR #11):

- One opaque bearer credential per device with a 30-day rolling expiry (`expiresIn` 30 d, `updateAge` 1 d). A stolen token stays valid while it keeps being used, until the user revokes it.
- Better Auth stores `session.token` in plaintext in the `session` table. A database read exposes live credentials. Better Auth 1.7.25 has no option to hash first-party session tokens (only some plugins, such as magic-link, offer hashed storage).
- No revoke-all endpoint in Qline's API yet (Better Auth's own `/v1/auth/revoke-other-sessions` and `/v1/auth/revoke-sessions` routes exist). No password-reset flow exists yet (no email provider), so `revokeSessionsOnPasswordReset` has nothing to act on.
- The mobile app has no session-management screen yet; the API is ready for one.
- `/v1/me/sessions*` is not rate-limited (Better Auth's limiter covers `/v1/auth/*` only). Low risk: the routes need a valid session.
- The Android client already keeps the token in `flutter_secure_storage` (Keystore-backed), see `apps/mobile/lib/core/session.dart`.

### 9.2 Can Better Auth 1.7.25 deliver Option C cleanly?

Checked against the installed package source (`node_modules/better-auth/dist`):

| Option C requirement | Better Auth 1.7.25 | Gap |
| --- | --- | --- |
| Short-lived access credential | `jwt` plugin issues signed JWTs (default 15 m, configurable) from a valid session, with JWKS | Supported, but the JWT is minted *from the long-lived session token*, so the session token remains the real credential. |
| Single-use rotating refresh credential | Not available for first-party sessions (refresh tokens exist only for OAuth provider accounts) | **Must be built by Qline.** |
| Refresh-token reuse detection and family revocation | Not available | **Must be built by Qline.** |
| Hash refresh credential at rest | Not available for sessions | **Must be built by Qline** (keyed hash). |
| Absolute + idle expiry | `expiresIn` + `updateAge` give rolling idle expiry only; `disableSessionRefresh` gives a fixed expiry | Absolute + idle together needs Qline logic. |
| Device/session list and revoke | `listSessions`, `revokeSession`, `revokeOtherSessions` | Supported (PR #11). |
| Secure Android storage | n/a (client) | Already in place. |

**Verdict: APPROVE WITH CONDITIONS — keep Better Auth for identity and sign-in; do not bolt rotation onto Better Auth sessions.** Better Auth cannot provide Option C by configuration. The clean design is:

1. Better Auth keeps password/Google sign-in and the `session` row as the *device record* (what the list/revoke API shows).
2. A new Qline table `auth_refresh_tokens` (migration `0008_…` or later; note `0008` is reserved for v1.5 missions, so use the next free number) stores `family_id`, `session_id`, keyed `token_hash`, `issued_at`, `last_used_at`, `absolute_expires_at`, `consumed_at`, `revoked_at`.
3. Sign-in returns a 10-minute signed access token (Better Auth `jwt` plugin or a Qline HMAC token) plus an opaque refresh token. `requireUser` validates the access token and checks the session row is still present (keeps instant revocation).
4. `POST /v1/auth/refresh` consumes the refresh token with one conditional `UPDATE … WHERE consumed_at IS NULL RETURNING`, issues a new pair in the same transaction, and on reuse of a consumed token revokes the family and the session. A short grace window (for example 10 s, returning the already-issued pair) covers two app requests racing a refresh; the client also single-flights refresh.
5. Idle expiry 7 d, absolute 30 d; password change, revoke and revoke-all delete the family.

### 9.3 Migration, compatibility and trade-offs

- **Migration:** additive table + new endpoint; no change to Better Auth tables. Existing 30-day tokens must keep working during rollout: accept the old bearer for one release (`QLINE_LEGACY_BEARER_UNTIL`), and have the app exchange it once for a refresh token on first launch. Then turn the legacy path off.
- **Compatibility:** requires a new APK (the refresh flow lives in `api.dart`/`session.dart`). Old APKs keep working only while the legacy path is on; `QLINE_MIN_CLIENT_BUILD` can force the upgrade afterwards.
- **Security gain:** a stolen access token is useful for ≤10 minutes; a stolen refresh token is detected on its next use by either party; credentials are hashed at rest.
- **Cost:** roughly one milestone of work (endpoint, table, middleware, client refresh with single-flight, ~15 integration tests for rotation/replay/race/expiry/revoke), and more moving parts in the auth path. Users who are offline more than 7 days must sign in again.
- **Cheaper interim (Option A):** `disableSessionRefresh: true` with a fixed expiry. One-line change, but no rotation, and it signs everyone out at the fixed time.

### 9.4 Owner decision required

Choose one (no auth configuration has been changed):

1. **Option C as designed above** (recommended), scheduled as its own milestone after v1.5 P0.
2. **Option A interim now** (state the fixed lifetime, for example 14 days), with Option C later.
3. **Keep the current 30-day rolling session** and accept the risk in T12 for now; PR #11's list/revoke still ships.
