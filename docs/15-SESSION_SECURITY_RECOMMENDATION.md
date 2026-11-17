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
