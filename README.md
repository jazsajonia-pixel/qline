# Qline

Qline is an AI-assisted business operating system for small teams: tasks, approvals, contacts, documents, memory, workflows and imports, with AI agents that **propose** actions and humans who **approve** them.

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
flutter build apk --release --dart-define=QLINE_API=https://<your-api-host> --dart-define=QLINE_VERSION=1.1.0 --dart-define=QLINE_BUILD=2
```

Release signing reads `apps/mobile/android/key.properties`. That file and the keystore are gitignored and are never committed.

## Honest status (v1.1.0)

Working end to end against production: sign-up/sign-in (email and password), organisations, invitations and roles, tasks, projects, comments, contacts, documents and notes, memory confirm/supersede/forget, search, approvals, guided setup with config versions and rollback, CSV/XLSX import with mapping and rollback, workflows (dry run, publish, enable, run), audit log verification, data export.

Not yet working, and the app says so instead of pretending:

- **AI agents / Live AI** work with your own keys (bring your own key). In Settings → AI providers an owner or admin can connect any of OpenAI, Anthropic (Claude), Google Gemini, xAI (Grok) and DeepSeek. Nothing is required: connect one, several or none. Keys are checked with the provider, encrypted at rest (AES-256-GCM, `QLINE_DATA_KEY`) and never returned to the app. Model lists come live from each provider. Each agent can use its own provider + model or the workspace default. With no key connected the app says so and saves messages without an answer.
  - Verified: adapters against recorded request/stream formats (unit tests), real fake-key rejection from all five providers, storage/assignment/runner against a Neon dev branch. Not verified by me: a real answer from each provider, because that needs your keys. Use **Test** on a provider card to check yours.
- **Google sign-in**: no OAuth client is configured. The button shows "not configured".
- **Integrations** (Gmail, Calendar, Slack, etc.): listed in the catalogue as not connected. No connector is live.
- **Email delivery**: invitations generate a code to share manually. No emails are sent.
- **Web companion**: planned, not built.
- **Push notifications**: planned.
