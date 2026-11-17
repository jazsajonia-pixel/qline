# Qline — Phase 0 System Design Pack

Version 0.1 · 2026-11-15 · Status: **design proposal for owner review — nothing is implemented**

> "Bring your business. Qline learns how it works, builds your workspace, and helps you run it."

This pack is the Phase 0 deliverable from the Qline Full App Development Master Prompt v1.0 (section 20, "Expected outputs before coding"). It is a design, not code. There is no repository, infrastructure, external app registration or deployment for Qline yet. The only hosted item is the interactive design prototype, a static preview that uses labelled sample data.

## What is in this pack

| # | Master prompt §20 output | Where |
| --- | --- | --- |
| 1 | Product requirements and MVP boundary | [01-PRODUCT_REQUIREMENTS.md](01-PRODUCT_REQUIREMENTS.md) |
| 2 | Full screen/page inventory (mobile + web) | [02-SCREENS_AND_FLOWS.md](02-SCREENS_AND_FLOWS.md) |
| 3 | User flows and navigation diagrams | [02-SCREENS_AND_FLOWS.md](02-SCREENS_AND_FLOWS.md) |
| 4 | High-fidelity mobile-first design system + screen designs | [03-DESIGN_SYSTEM.md](03-DESIGN_SYSTEM.md) + interactive prototype |
| 5 | Portrait Live AI states + agent identity variants | [03-DESIGN_SYSTEM.md §6](03-DESIGN_SYSTEM.md) + prototype "Live AI" |
| 6 | Component inventory + interaction specs | [03-DESIGN_SYSTEM.md §5](03-DESIGN_SYSTEM.md) |
| 7 | System architecture diagram | [04-ARCHITECTURE.md](04-ARCHITECTURE.md) |
| 8 | Database ERD + tenant isolation plan | [05-DATA_MODEL.md](05-DATA_MODEL.md) |
| 9 | API and realtime event contracts | [06-API_AND_EVENTS.md](06-API_AND_EVENTS.md) |
| 10 | Agent, tool and approval policy matrix | [07-AI_AGENT_POLICY.md](07-AI_AGENT_POLICY.md) |
| 11 | Business onboarding and import flow | [08-ONBOARDING_IMPORT_WORKFLOWS.md](08-ONBOARDING_IMPORT_WORKFLOWS.md) |
| 12 | Workflow execution model | [08-ONBOARDING_IMPORT_WORKFLOWS.md §3](08-ONBOARDING_IMPORT_WORKFLOWS.md) |
| 13 | Integration feasibility matrix | [09-INTEGRATIONS.md](09-INTEGRATIONS.md) |
| 14 | Threat model + privacy plan | [10-SECURITY_THREAT_MODEL.md](10-SECURITY_THREAT_MODEL.md) |
| 15 | Phased implementation roadmap | [11-ROADMAP_AND_TESTING.md](11-ROADMAP_AND_TESTING.md) |
| 16 | Test plan + acceptance criteria | [11-ROADMAP_AND_TESTING.md](11-ROADMAP_AND_TESTING.md) |
| 17 | Architecture spike + v1.4 durable runtime | [12-DURABLE_RUNTIME_V1_4.md](12-DURABLE_RUNTIME_V1_4.md) |

## Visual references used

These come from the owner's Google Drive. They are the four most recent image uploads, made 2026-11-15:

1. `file_00000000d0dc82078bb33ce57d1bc251.png` is the **primary reference**. It is a 20-screen "FounderOS — Mobile MVP System Design" board: welcome, sign-in, workspace setup, command center, Live AI, workforce, agent profile, work, approval, CRM, client detail, inbox, calendar, finance, growth, knowledge, automation, integrations, settings and adaptive agent presence.
2. `Screenshot_20261115-213907.png` is a reel frame showing a violet energy core with a thin ivory ring, flowing ribbons and a "LISTENING" vertical HUD rail.
3. `Screenshot_20261115-213930.png` is a reel frame showing a teal core inside a warm amber ring, with crossing amber and cyan strands and a "PROCESSING" rail.
4. `Screenshot_20261115-213933.png` is the same scene in the "LISTENING" state, with a wider halo and calmer strands.

**How they are used:** the board defines the screen inventory, the module set and the information density Qline should match. The reel frames define the motion language and the state-by-state behaviour of the Live AI core. Qline does **not** copy FounderOS branding, its violet-everywhere palette or the third-party reel artwork. See [03-DESIGN_SYSTEM.md §1](03-DESIGN_SYSTEM.md) for what is borrowed and what is deliberately different.

## Decisions the owner needs to make

These block the start of Phase 1 work:

1. **Approve or amend this design**, especially the MVP boundary (01 §6), the navigation model (02 §1) and the visual thesis (03 §1).
2. **Mobile stack.** The recommendation is Flutter 3.50 + Riverpod 3.5, as the master prompt proposes. An earlier handoff suggested also considering Expo/React Native. See 04 §2.
3. **Platforms.** The recommendation is Android first, with iOS planned once there is an Apple developer account and a device to test on.
4. **FounderOS.** The recommendation is a clean build. FounderOS would be a reference only, not forked (see 04 §2), and its MIT licence would still be reviewed before any code is reused.
5. **First AI provider(s)** for the provider-neutral adapter. A paid provider needs the owner's account and budget.
6. **Hosting and cost ceiling.** This covers Neon Postgres, the worker host (Fly.io, Railway, Render or similar) and object storage (Cloudflare R2 or S3). Nothing paid is created without approval.
7. **Repository.** Approve creating `jazsajonia-pixel/qline` (private monorepo). It is **not created yet**.

## Honest status

| Item | Status |
| --- | --- |
| Product scope (all 15 modules) | Documented in this pack |
| Design system + 20 mobile screens + Live AI states | Interactive prototype with sample data; not a real app |
| Backend, auth, database, AI, workflows, integrations | Planned; nothing implemented |
| Device testing | Not applicable yet |
| Stack versions | Checked 2026-11-15 against official/registry sources (04 §2); re-check when scaffolding |
