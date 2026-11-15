# 11 — Phased Roadmap, Test Plan and Acceptance Criteria

## 1. Roadmap (vertical slices; each phase ends with green CI and its acceptance demo)

| Phase | Slice | Acceptance (from master prompt §15, made testable) | Owner approvals needed first |
| --- | --- | --- | --- |
| **0** Discovery & design | This pack + prototype | Owner approves or amends the docs and prototype | — |
| **1** Secure foundation | Monorepo, CI, Better Auth + orgs/workspaces/roles, Drizzle schema + RLS, audit foundation, storage foundation, mobile + web shells, workspace switcher | Sign up, create 2 orgs, and the isolation suite proves B cannot touch A's data for every family that exists; mobile and web sign in against the preview API | Create the repo; Neon project; container host; storage bucket |
| **2** Onboarding & import | Interview, uploads, CSV/XLSX/PDF/DOCX/TXT/MD/JSON parsers, mapping, duplicates, process capture, proposal, apply, versions, rollback; Drive picker import | A test business imports clients.csv + an SOP.docx, corrects 2 mappings, approves the proposal, sees the modules and records, rolls back to v0 and re-applies | Google Cloud project + OAuth consent screen (Drive) |
| **3** Command Center, Work, Library | Dashboard widgets from real data with drill-down, projects/tasks list + board, documents, memory provenance, search, activity feed | Every number on Home links to its records; no widget renders without its data source; tasks and docs are usable on mobile and web | — |
| **4** Live AI & agents | Provider adapter (1 provider), conversations, SSE streaming, Live AI screen with all states, AI CEO persona, tool registry, policy engine, approvals, run history, budgets | The AI CEO answers "what's overdue" with task citations, proposes a task, the approval is granted by a human, the task is created, and the run, tool call and audit are visible. Agent tokens cannot approve. | AI provider account + budget |
| **4b** Voice | Push-to-talk STT, optional TTS, permission flows | Verified on a real Android device; mic-denied path works; labelled turn-based | STT/TTS provider choice |
| **5** Approvals & workflows | Workflow model, mobile viewer, web canvas editor (@xyflow/react), pg-boss engine, dry-run, logs, retries, DLQ | The MVP template runs end-to-end with an approval gate; a loop test is blocked; a cross-tenant trigger is impossible | — |
| — | **MVP release candidate** | J1–J8 pass on a real Android phone + web; security review of tenant boundaries | Release signing key; store listing (if any) |
| **6** CRM, inbox, calendar | Pipelines, deals, client timeline, Gmail read/draft/send-with-approval, Calendar | Test Gmail account connected; thread summary; approved send; audit trail | Google verification path for Gmail scopes |
| **7** Finance & growth | Transactions import, categories, cash flow, Stripe read-only; content calendar, approvals; one social API after review | Imported vs connected data clearly labelled; nothing simulated as published or paid | Per-platform app reviews |
| **8** Integrations & multi-agent | Slack, Notion, GitHub, connector SDK + health, delegation, per-agent quotas, Stage 7 adaptation, custom roles | Two agents collaborate through explicit handoffs with no permission escalation (property tests) | — |
| **9** Hardening & release | Performance, accessibility, load/failure, backup restore drill, privacy/legal review, store prep, monitoring | Release gates pass; KNOWN_LIMITATIONS.md is current | Legal review; store accounts |

## 2. Test plan

| Layer | Tooling | Must cover |
| --- | --- | --- |
| Policy & domain (pure TS) | Vitest, property tests (fast-check) | Every cell of the 07 §3 matrix; delegation ∩ rules; approval invariants |
| API integration | Vitest + Testcontainers Postgres (RLS on, non-owner role) | Auth/session, membership and role changes, **isolation suite**, import idempotency and rollback, config apply/rollback, approvals, idempotency keys, webhook signatures and replay, export/delete |
| Workers | Vitest + pg-boss test harness | Retries, timeouts, DLQ, loop guard, re-authorization on resume |
| AI | Mock provider + recorded fixtures; eval set per template | Tool routing, streaming events, provider failure fallback, injection red-team prompts, "claim without tool call" detector |
| Web | Playwright | Responsive at 375/768/1280, workflow editor keyboard use, import mapping, approvals |
| Mobile | `flutter test` (widget + golden), integration_test on an emulator in CI | Navigation, keyboard-safe composer, Live AI state rendering per state (goldens), reduced motion, 200% text scale, deep links, mic permission flows (mocked) |
| Manual | Checklist in `docs/TESTING.md` | Real Android device (owner's TECNO KN8 or another), font scaling, poor network/offline, mic granted/denied, backgrounding during a voice turn, OAuth connect/revoke with test accounts, representative business files, backup restore |

**Definition of done** (master prompt §16): the behaviour, error handling, authorization and tests work. A screen existing is not enough. The status labels used in the README are Implemented / Tested / Not tested on real device / Planned / Blocked / Unsupported.

## 3. Phase 1 starter backlog (ready once approved)

1. Scaffold the monorepo, CI (lint, typecheck, test, build, flutter analyze/test) and branch protection.
2. Drizzle schema for identity/tenancy plus RLS policies, a migrations runner and the non-owner app role.
3. Better Auth with the organization plugin, email verification and password reset (email provider choice needed), and Google sign-in.
4. `TenantContext` middleware, a repository wrapper and the lint rule banning raw db access.
5. Isolation suite generator plus the first families (orgs, members, workspaces).
6. Audit hash chain table and service.
7. Flutter shell: theme tokens from 03, bottom nav, workspace switcher, sign-in screens, secure storage.
8. Next.js shell: sidebar, sign-in and org switcher.
9. `/v1/health` endpoints, structured logging with correlation ids.
