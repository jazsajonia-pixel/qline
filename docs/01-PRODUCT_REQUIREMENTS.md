# 01 — Product Requirements and MVP Boundary

## 1. Product definition

Qline is a mobile-first, multi-tenant **AI Business Operating System**. A customer brings their business (files, connected services and plain-language explanations). Qline proposes a workspace configured around how that business actually works, and people and permission-bound AI agents operate it together. A responsive web companion uses the same backend and data model.

What makes it different: **adaptive onboarding** (import → understand → propose → approve → roll back) combined with **governed agents** (every tool call is scoped, logged and approval-gated by policy). Neither a chatbot nor a CRM does both.

## 2. Personas

| Persona | Context | Primary job in Qline | Key fear |
| --- | --- | --- | --- |
| **Solo founder / freelancer** (MVP anchor) | Runs the whole business from a phone between client work | "Tell me what matters today and draft the boring parts" | AI doing something embarrassing to a client |
| **Small business owner** | 2–15 staff, spreadsheets + Gmail + chat | Get scattered data into one place without re-typing | Losing or overwriting existing records |
| **Agency owner** | Several client accounts, may need separate workspaces | Separate brands/clients, repeatable onboarding templates | Client data leaking across accounts |
| **Team member** | Assigned tasks and approvals | Clear queue, quick approvals, mobile-friendly | Unclear ownership |
| **Workspace admin** | Owner or delegate | Roles, connectors, agent permissions, audit | Over-broad access |
| **External collaborator** | Limited, resource-scoped access | View/comment on one project | Seeing more than intended (must not) |

## 3. Key journeys (MVP-critical in bold)

1. **J1 Sign up → create organization → choose Hybrid onboarding.**
2. **J2 Business interview with skip/unknown → profile with provenance and confidence.**
3. **J3 Upload a CSV/XLSX of clients → preview → map fields → resolve duplicates → import.**
4. **J4 Describe a process in plain language → structured workflow draft with flagged gaps.**
5. **J5 Review the workspace proposal (before/after diff) → approve → configuration v1 saved → roll back to v0 works.**
6. **J6 Open the Command Center → see only metrics backed by imported data → drill down to records.**
7. **J7 Ask the AI CEO agent "What's overdue this week?" → streamed answer with source references → agent proposes a task → user approves → task created and logged.**
8. **J8 Run one workflow (new lead → summary → draft follow-up → approval → internal record), with visible run logs.**
9. J9 Connect Gmail and summarise a thread (Phase 6).
10. J10 "Our sales process changed" → impact analysis → approve the new configuration version (Phase 2 foundation, full in Phase 8).

## 4. Functional scope — all modules preserved

The status words below follow master prompt §19: **MVP** = in the first usable release, **Planned** = in the roadmap phase given.

| Module (master prompt §5) | MVP slice | Later | Phase |
| --- | --- | --- | --- |
| 2 Accounts, orgs, workspaces, RBAC | Email/password + Google sign-in, orgs, workspaces, Owner/Admin/Member/Viewer, invites | Manager role UI, custom roles, external collaborators, SSO | 1 / 8 |
| 3 Adaptive onboarding | All 3 modes, stages 1–6, configuration versions + rollback | Stage 7 continuous adaptation with full impact analysis | 2 / 8 |
| 5.1 Command Center | Real-data widgets, briefing with sources, approvals, drill-down | Custom layouts, date-range comparisons | 3 |
| 5.2 Live AI | Text-first portrait interface, all visual states, streaming, stop, history, tool timeline | Push-to-talk STT/TTS once the pipeline is verified; hands-free mode | 4 / 4b |
| 5.3 AI Workforce | 1 working persona (AI CEO / Chief of Staff); the roster shows other templates as "Not set up" | 6 templates, custom agents, delegation, evaluations | 4 / 8 |
| 5.4 CRM | Contacts/clients from import (read + edit) | Pipelines, deals, duplicate merge, AI drafts | 6 |
| 5.5 Unified inbox | — (shown as "Not connected") | Gmail first | 6 |
| 5.6 Calendar | — (shown as "Not connected") | Google Calendar | 6 |
| 5.7 Work | Projects, tasks, subtasks, statuses, assignees, list + board | Dependencies, recurring tasks, templates, time tracking (only if built) | 3 |
| 5.8 Finance | — (shown as "Planned") | Import transactions, categories, cash flow; no payments | 7 |
| 5.9 Growth Studio | — (shown as "Planned") | Content calendar, approvals, official social APIs | 7 |
| 5.10 Knowledge & memory | Upload docs, folders, full-text search, memory records with provenance | Semantic retrieval if measured to help; per-agent scopes UI | 3 |
| 5.11 Automation Studio | 1 workflow template, mobile viewer, web editor (basic), dry-run, run logs | Branches, schedules, webhooks, versions UI | 5 |
| 5.12 Integrations hub | Connector framework + truthful status; Google Drive import read-only | Gmail, Calendar, Slack, Notion, GitHub, Stripe read-only | 2 / 6 / 8 |
| 5.13 Approvals, audit, security | Approval center, audit log, sessions list | Escalation/expiry policies, security alerts | 4–5 |
| 5.14 Settings & admin | Profile, org, members, AI provider keys (server-side), theme/motion | Budgets UI, quiet hours, feature flags | 1–5 |
| 5.15 Multi-business | Multiple orgs per user + switcher + isolation tests | Per-org quotas UI | 1 |

## 5. Non-functional requirements

- **Performance:** cold start on a mid-range Android phone in under 2.5 s to the first meaningful screen; Live AI core at 60 fps, falling back to 30 fps on low-power mode; a list of 1,000 tasks scrolls without jank.
- **Reliability:** idempotent imports and workflow actions, a dead-letter queue for failing jobs, and a visible status for every background job.
- **Security:** tenant isolation proven by automated tests for every resource family (see 10).
- **Accessibility:** WCAG 2.2 AA contrast, TalkBack labels, 200% text scale without clipping core content, reduced motion.
- **Offline:** read-only cached lists for tasks, records and library metadata; drafts queued locally; **external actions never queued offline**.
- **Locale:** multi-currency, locale formatting and time zones; no PHP or Manila assumptions.

## 6. MVP boundary (first usable release)

**In:** master prompt §17 items 1–15. The Live AI ships text-first with the full visual state system. Voice is added only after STT/TTS is verified on a real Android device.

**Out of the MVP but kept in the plan:** CRM pipelines, inbox, calendar, finance, growth, broad integrations, multi-agent delegation, custom roles, billing.

**MVP done means:** journeys J1–J8 pass on a real Android device and the web companion, cross-tenant tests pass for every resource family, and CI is green.

## 7. Explicit non-goals

All of master prompt §18 applies. The ones most likely to be tempting in this product:

- No elaborate core animation before chat, permissions, streaming and error states work. The prototype exists to settle the design, not to skip that order.
- No KPI tiles unless their source data exists. Empty states guide the user to import instead.
- No "Connected" badge until an end-to-end connector test has passed.
- An agent can never approve its own action, and a delegated agent cannot inherit more scope than the delegator has.

## 8. Open questions

1. Does the MVP need a "personal workspace" for freelancers, or is a one-person organization enough? Recommended: a one-person organization, so there is a single code path.
2. Should invitations require email verification first? Recommended: yes.
3. Data residency: is there any customer region requirement? This affects the database region.
4. Pricing model: per seat, per organization or per AI usage? This affects quotas, but billing stays out of the MVP.
