# 21 — Personal AI OS: what was built in phases 1–8 (v1.8.0)

Written 2026-11-19. It follows the phased plan in [docs/20](20-PERSONAL_AI_OS_BASELINE_M0.md). Every claim below is one of:

- **Implemented**: the code is merged.
- **Tested**: the code is covered by automated tests that pass locally and in CI. The tests use a local or CI Postgres and mocked provider endpoints.
- **Not verified**: nobody has checked it on a physical device, against a live provider account, or with real users.

**No part of v1.8.0 has had device QA.**

## Decisions taken without a separate owner sign-off

The owner asked for the plan to be carried out without further questions. Where docs/20 offered options, the recommended or least risky one was chosen:

| Topic | Decision | Why |
|---|---|---|
| ADR-1 personal tenancy | **Option B.** A personal space is an organization with `settings.kind = 'personal'`. Each user has at most one, and nobody can be invited into it. | It reuses the existing RLS, roles, audit and agents without a tenant-model rewrite. Business spaces are unchanged. |
| Personal agents | Personal spaces get the same built-in agent set as business spaces. | This avoids a second agent catalog. The cost is that some agent names still sound business-oriented. |
| Session lifetime and token storage | **Unchanged.** Sessions last 30 days (rolling), and session tokens are stored as plaintext in the Better Auth `session` table. | Hashing the tokens or shortening sessions would sign everyone out. That change needs a planned migration (docs/15). |
| Password reset and email verification | **Not built.** | Both need an email provider, which can cost money. None was added. |
| Key routing (M10) | A pinned key is used strictly, with no fallback. Otherwise Qline uses the least-recently-used eligible key. A 429 starts a cooldown (60 s, doubling up to 15 min) and the turn retries once on another key. | Extra keys do not raise a provider's own limits. This is not advertised. |
| Custom agents (M9) | New agents start **paused** with read-only tools. Their tools are capped by the `based_on` profile. | Least privilege. |
| Voice (M6) | Free and on-device only. No realtime or paid speech provider was added. | No cost estimate or approval exists for a paid provider. |

## Phases

| Phase | PR | Implemented | Tested | Not verified |
|---|---|---|---|---|
| 1 — M1 remainder | [#26](https://github.com/jazsajonia-pixel/qline/pull/26) | OAuth token and identity timeouts. Single-flight token refresh. Temporary provider failures return 503 and no longer expire the connection. Streamed upload limits, zip-bomb check, 25 s parse deadline, column and page caps. | Unit tests, plus an integration test where 5 concurrent refreshes make 1 provider call | Live Google, Microsoft and Slack token endpoints |
| 2 — sessions | [#27](https://github.com/jazsajonia-pixel/qline/pull/27) | Sign-in rate limits stored in Postgres (migration 0015), so they hold across instances. Sign out other devices. | 11th wrong password returns 429; revoke-others | Rate limit behaviour behind Neon's proxy IPs in production |
| 3 — UX gaps | [#27](https://github.com/jazsajonia-pixel/qline/pull/27) | File download route and file card. Per-conversation drafts. Per-person knowledge map layout. Predictive Back flag. | Download headers, cross-org 404, audit; widget tests | Android predictive Back animation on a device |
| 4 — M10 + M9 | [#28](https://github.com/jazsajonia-pixel/qline/pull/28) | Several keys per provider (migration 0016) with health, cooldown and routing. Custom agents with versions, preview, clone, revert, archive and budgets. | `keys-agents.integration.test.ts` (5); `p4_keys_agents_test.dart` (3) | Real 429 and 401 responses from live providers |
| 5 — M7 Drive | [#29](https://github.com/jazsajonia-pixel/qline/pull/29) | `drive.search` filters by kind and orders by created or modified time. `drive.fetch` copies a file into Qline storage (migration 0017), showing images inline and other files as a download card. "Last saved" is only claimed for createdTime ordering. | Mocked Drive integration test: ordering, export, size limits, reuse, cross-org | A real Google Drive account. Drive scopes for public users need Google verification. |
| 6 — M8 proposals | [#30](https://github.com/jazsajonia-pixel/qline/pull/30) | Typed `missions.propose` and `agents.propose_change` (migration 0018). Proposals are reviewed, edited, applied or rejected by a person through the same routes as manual changes. | `proposals.integration.test.ts` (4); `p6_proposals_test.dart` (3) | The quality of real model proposals |
| 7 — ADR-1 + M11 | [#31](https://github.com/jazsajonia-pixel/qline/pull/31) | Personal space (`POST /orgs {kind:'personal'}`). First run defaults to "Just me". Life domains (migration 0019: Personal, Work, Learning, Projects, Health, Money). `tasks.domain_id` with a filter. Domains screen. Invitations are blocked in personal spaces. | `personal.integration.test.ts` (2); `p7_personal_test.dart` (3) | First-run experience with real users |
| 8 — M6 voice | [#32](https://github.com/jazsajonia-pixel/qline/pull/32) | Adaptive end-of-turn wait (800–2600 ms, depending on how the words end). The recogniser's own pause is raised to 3 s so the adaptive wait decides. Tap-to-interrupt and sentence chunking already existed and are unchanged. | `p8_voice_test.dart` (4, fake clock) | Speech timing on real devices, and in noisy rooms |

## Not done

- The assistant does not pick a life domain for a task by itself. Domains are set by hand or through `domainId` in the API.
- Knowledge, notes and conversations have no domain yet. Only tasks do.
- Existing users are not moved into a personal space. They can add one from the space switcher.
- Voice: there is no spoken barge-in while TTS is playing (tap only), no streaming TTS from a provider, and no realtime voice provider.
- Password reset and email verification (needs an email provider). Session token hashing.
- Device QA for any release, and live-provider tests for Drive, Gmail, Slack, Notion, GitHub, Stripe and the model providers.

## Rollback

- Migrations 0015–0019 only add tables, columns and check values. The v1.7.0 API ignores them.
- The Neon branch `pre-v1-8-restore-point` was taken before they were applied to production.
- Keys added in 1.8 only live in `ai_keys`. The primary key is still mirrored in `ai_provider_keys`.
