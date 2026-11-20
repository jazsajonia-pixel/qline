# Qline

Qline is a personal AI operating system: one assistant that remembers your context across chats, reads the files and apps you connect, and acts for you only within the permissions you set. Teams and businesses are optional scopes on top of the same personal core. Agents **propose** consequential actions and a human **approves** them.

This repository holds the Android app, the API and the shared packages.

## What's here

| Path | What it is |
|---|---|
| `apps/mobile` | Flutter Android app (Riverpod, `material_ui`, custom-painted energy core for Live AI) |
| `services/api` | Hono API with Better Auth, deployed as a Neon Function |
| `packages/schema` | SQL-first migrations and the migration runner |
| `packages/policy` | Risk levels L0–L4 and the approval policy engine |
| `packages/ai` | Model gateway client, agents and tool definitions |
| `docs/` | Phase 0 system design pack (PRD, screens, design system, architecture, data model, API, AI policy, security, roadmap) |
| `docs/prototype` | The clickable Phase 0 prototype |

## Architecture in one paragraph

The app talks to a single HTTPS API (`/v1`) using a Better Auth bearer token plus an `X-Qline-Org` header. Every request runs inside an org-scoped Postgres transaction on Neon. AI runs are streamed to the app over Server-Sent Events. Any tool call an agent makes is classified L0–L4 by `packages/policy`. Anything above L1 becomes an approval card that a human must approve before it runs. Every mutation is written to a hash-chained audit log that you can verify from Settings → Audit. Files live in a Neon storage bucket. Scheduled workflows run from a Neon trigger every 15 minutes.

## Running it

```bash
# API
npm ci
npm run typecheck
npm run test:unit
QLINE_TEST_ENV=/path/to/dev.env npm run test:integration   # needs a Neon dev branch
npm run build:api

# Android app (Flutter 3.50+, JDK 21, Android SDK 36)
cd apps/mobile
flutter pub get
flutter analyze && flutter test
flutter build apk --release --dart-define=QLINE_API=https://<your-api-host> --dart-define=QLINE_VERSION=1.3.1 --dart-define=QLINE_BUILD=5
```

Release signing reads `apps/mobile/android/key.properties`. That file and the keystore are gitignored and are never committed.

## Honest status (v1.11.0, in progress)

On main, not deployed or released yet: Voice v2 and background continuity ([docs/26](docs/26-VOICE_V2_AND_CONTINUITY.md)) and Facebook Pages posting with approval ([docs/27](docs/27-FACEBOOK_PAGES.md)). Both are tested with automated tests only: no device QA, and Facebook has not been tried against a real Page because no Meta app is registered. Production still runs 1.10.0.

### Earlier notes (v1.10.0)

v1.10.0 expands GitHub beyond issues: the AI can browse repositories, read and search code, inspect branches, commits, pull requests and CI, and, only after you approve a diff, create working branches, commit files and open, edit or comment-review pull requests. It never pushes to the default or a protected branch, merges, force-pushes, changes workflows or reads secrets. Production runs API 1.10.0 with migration 0025 (applied 2026-11-20). It needs the GitHub App permissions in [docs/24](docs/24-GITHUB_INTEGRATION.md), which also lists what was and wasn't verified.

### Earlier notes (v1.9.0)

v1.9.0 adds Content Studio under Command Center: video handoffs to an outside editor through Google Drive, with Qline checking the finished video itself before a person reviews it. It needs API 1.9.0 with migrations 0020–0024; on an older server the app says so. Editor spec: [docs/23](docs/23-EDITOR_HANDOFF_SPEC.md). Verification notes: [docs/22](docs/22-CONTENT_HANDOFF_BASELINE.md).

### Earlier notes (v1.8.0)

v1.8.0 adds personal spaces with life domains, custom agents, several keys per AI provider, AI proposals you approve, Google Drive files in chat, safer OAuth refresh, upload limits, shared sign-in limits, and an adaptive voice end-of-turn.

- What is implemented, tested and not verified: [docs/21](docs/21-PERSONAL_AI_OS_BUILD.md).
- Earlier releases: [docs/releases](docs/releases).
- No release has had device QA.

### Earlier notes (v1.4.0)

Working end to end against production: sign-up/sign-in (email and password), organisations, invitations and roles, tasks, projects, comments, contacts, documents and notes, memory confirm/supersede/forget, search, approvals, guided setup with config versions and rollback, CSV/XLSX import with mapping and rollback, workflows (dry run, publish, enable, run), audit log verification, data export.

New in 1.4.0:
- **Durable automation runtime.** Transactional outbox, leased jobs, retries/backoff, dead-letter handling, cancellation, schedule/event dispatch and recovery are deployed on Neon.
- **Supervised Operations.** The app includes run history, run details, background-job visibility and permission-checked operations. Unknown external outcomes require human resolution; they are not blindly resent.
- **Slack workflow posts require human approval.** This is enforced server-side.

New in 1.2.0 (code complete and tested; see the verification notes):

- **Integrations with per-user sign-in.** Google (Gmail lead inbox, Sheets, Forms, Calendar), Microsoft (Outlook lead inbox) and Slack (alerts). Each person signs in with their own account; Qline only asks for the scopes of the features they tick. Tokens are encrypted at rest. The server owner registers one OAuth app per provider once and enters its client ID/secret in Integrations → Integration setup. See [docs/integration-setup.md](docs/integration-setup.md).
- **Lead inbox.** New mail is checked for leads by rules (keywords, ignored domains) and, if a model is connected, by AI. Each lead gets an urgency (urgent / normal / low). Lead rules can be drafted by AI from a plain-language description and tried in a tester. Leads can sync to a Google Sheet and come in from a Google Form.
- **Automations.** Ready-made recipes ("Turn on") and new workflow steps: AI, Slack message, email draft, calendar event. Triggers include new lead and urgent lead.
- **Natural voice.** Choose the device voice (free, offline) or Gemini or OpenAI voices through your own key (Gemini has a free tier). Captions light up word by word and the energy core follows the audio level. Hands-free mode (hearing icon in the composer) keeps listening after each reply; say "stop listening" or tap End. Tap the core to interrupt.
- **New palette** "Mint Signal on Violet Ink", press/reveal motion that respects reduced motion.

Verification:

- Verified: API unit tests, the 12-test integration suite against a Neon dev branch (OAuth state, token sealing, Gmail/Graph/Slack/Sheets calls against mocked provider endpoints, lead classification by rules and AI, recipes), `flutter analyze`, the widget tests, and rendered screenshots of the new screens, including Live captions and the hands-free bar.
- Not verified: real OAuth logins (these need the registered apps); Gmail lead reading for accounts outside Google's Testing-mode list (Gmail read access is a restricted scope: Testing mode allows 100 test users and logins expire after 7 days; going public needs Google's security review); real Gemini/OpenAI speech (needs your keys); Forms creation against live Google; the APK on a physical device.

Still not built:

- **Email delivery**: invitations generate a code to share manually.
- **Web companion** and **push notifications**: planned.
