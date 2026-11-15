# 04 — System Architecture

## 1. Diagram

```mermaid
flowchart LR
  subgraph Clients
    M[Flutter app<br/>Android first]
    W[Next.js web companion]
  end
  subgraph Edge
    API[Qline API<br/>Hono + TypeScript<br/>REST + SSE/WebSocket]
  end
  subgraph Core services (modules in one deployable at first)
    AUTH[Auth + org membership<br/>Better Auth]
    POL[Policy / permission engine]
    APR[Approval service]
    CONV[Conversation service]
    ORCH[Run orchestrator]
    CTX[Context builder<br/>tenant-scoped retrieval]
    TOOLS[Tool registry<br/>Zod schemas]
    MEM[Memory service]
    CFG[Workspace config<br/>versions + rollback]
    IMP[Import service]
    WF[Workflow engine]
    CON[Connector framework]
    AUD[Audit + usage]
  end
  subgraph Workers (long-running, not serverless)
    Q[(Durable queue<br/>pg-boss on Postgres)]
    WK1[Import/parse worker<br/>sandboxed]
    WK2[Agent run worker]
    WK3[Workflow + scheduler worker]
    WK4[Connector sync + webhook worker]
  end
  subgraph Data
    PG[(PostgreSQL 16+<br/>Drizzle ORM, RLS defence-in-depth)]
    OBJ[(Private object storage<br/>signed URLs ≤ 5 min)]
    KMS[(Secrets: envelope encryption<br/>KMS-held master key)]
  end
  subgraph External
    LLM[AI providers via adapters]
    STT[STT / TTS adapters]
    G[Google, Slack, Notion, GitHub, Stripe…]
  end
  M & W -->|HTTPS, bearer session| API
  API --> AUTH & POL & CONV & CFG & IMP & WF & CON & APR & MEM
  CONV --> ORCH --> CTX --> MEM
  ORCH --> TOOLS --> POL --> APR
  API --> Q
  Q --> WK1 & WK2 & WK3 & WK4
  WK2 --> LLM
  API --> STT
  WK4 --> G
  CON --> KMS
  Core services --> PG
  WK1 --> OBJ
  AUD --> PG
```

**Shape:** this is a **modular monolith** API plus separate worker processes that share one Postgres. Services are code modules with explicit interfaces, not microservices. They can be split out later if load or isolation needs it. This keeps a solo-founder build maintainable.

## 2. Stack (versions checked 2026-11-15)

| Layer | Choice | Version evidence | Why |
| --- | --- | --- | --- |
| Mobile | Flutter + Dart + Riverpod | Flutter 3.50.0 / Dart 3.14.0 released 2026-11-11 ([Flutter release notes](https://docs.flutter.dev/release/release-notes)); flutter_riverpod 3.5.0, 2026-11-06 ([pub.dev](https://pub.dev/packages/flutter_riverpod/changelog)) | Owner's established mobile stack (Sapphire, Heartline, Retext); `CustomPainter`/fragment shaders suit the agent core |
| Web | Next.js + React + TypeScript | Next.js 16.4.6 latest stable, 2026-11-09 ([GitHub releases](https://github.com/vercel/next.js/releases)) | Matches the master prompt and the owner's web stack |
| API | Hono + TypeScript + Zod | Pin at scaffold | Runs on Node for the stable API host; shares Zod schemas with web |
| Auth | Better Auth (organization plugin) | 1.7.25 ([Better Auth changelog](https://better-auth.com/changelog)) | Orgs, members, invitations and teams built in; the owner already uses it (Unified Connector, OmniDesk). Subscribe to its security releases. |
| DB | PostgreSQL (Neon) + Drizzle ORM | Pin at scaffold | Owner's standard; branching fits preview environments |
| Queue | pg-boss (Postgres-backed) | Pin at scaffold | No extra infrastructure; durable and transactional with app data; swap later if throughput needs it |
| Storage | S3-compatible (Cloudflare R2 or S3) | — | Private buckets, signed URLs |
| Realtime | SSE for token streams; WebSocket for presence/notifications; polling fallback | — | SSE is simplest for one-way streaming on mobile |
| Search | Postgres full-text (`tsvector`) | — | The spec says vectors only when measured to help |
| CI | GitHub Actions | — | Note: other owner repos hit an **Actions billing block**; resolve before relying on CI |

**Mobile alternative considered:** Expo/React Native would share TypeScript with web and API. It was rejected as the default because the master prompt names Flutter, the owner ships more Flutter apps, and the core animation is easier to make smooth with Flutter's painter/shader pipeline. The cost is that Zod schemas are not shared with Dart. The mitigation is an **OpenAPI spec generated from Zod**, with a Dart client generated from it in CI.

**FounderOS:** treat it as a feature reference only. Forking would bring its web-first architecture and single-tenant assumptions into a product whose core requirement is multi-tenancy. If specific code is reused, check the MIT licence and keep its notice.

## 3. Repository layout (proposed, not created)

```
qline/
  apps/mobile/        Flutter app (feature-first folders, Riverpod)
  apps/web/           Next.js
  services/api/       Hono API (modules/*), OpenAPI generation
  services/worker/    pg-boss workers (import, agent, workflow, sync)
  packages/schema/    Drizzle schema + migrations + Zod contracts
  packages/policy/    Permission + approval policy (pure TS, heavily tested)
  packages/ai/        Provider adapters, tool registry
  docs/               the docs from this pack
  .github/workflows/  ci.yml (lint, typecheck, test, build, flutter test, isolation suite)
```

## 4. Environments and deployment

| Env | Web | API | Workers | DB |
| --- | --- | --- | --- | --- |
| Local | `next dev` | Node | Node | Docker Postgres |
| Preview (per PR) | Vercel preview | Container preview | Container | Neon branch |
| Production | Vercel | Container host with persistent processes (Fly.io / Railway / Render — owner to choose) | Same host, separate process group | Neon main + PITR |

Vercel is fine for the web app. The API must also host SSE streams and the workers must run for minutes, so neither goes on short serverless functions (master prompt §7).

## 5. Key cross-cutting rules

- Every request resolves `(userId, orgId, workspaceId, role)` from the session and the `X-Qline-Org` header, validated against membership on the **server**. Each service receives a `TenantContext`; repositories require it, and there is no query helper without it.
- Every job payload carries the `TenantContext` and the **initiating user id**. The worker re-checks authorization when it runs the job.
- Correlation id: generated at the edge and propagated to logs, agent runs, tool calls, workflow runs and audit events.
- Configuration changes go through the `CFG` service only, as versioned proposals applied in a transaction.
