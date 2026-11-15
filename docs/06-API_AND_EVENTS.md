# 06 — API and Realtime Event Contracts

The API is REST plus JSON under `/v1`, with OpenAPI generated from Zod and Dart/TS clients generated in CI. Auth uses a Better Auth session (an httpOnly cookie on web; a bearer token in secure storage on mobile). The active org comes from the `X-Qline-Org` header and is validated against membership on every request.

## 1. Conventions

- Errors follow `application/problem+json`: `{ type, title, status, detail, code, correlationId, fields? }`. Codes are stable, for example `APPROVAL_REQUIRED`, `TENANT_NOT_FOUND` and `CONNECTOR_NOT_CONFIGURED`.
- `Idempotency-Key` is required on every POST that creates or triggers something. The server stores the key with a response hash for 24 h.
- Lists use cursor pagination (`?cursor=&limit=` with a maximum of 100) plus `filter[...]` and `sort`.
- Rate limits are per user and per org; responses carry `RateLimit-*` headers.
- Cross-tenant ids return **404**.

## 2. Endpoint groups (MVP)

| Group | Endpoints |
| --- | --- |
| Auth | `/v1/auth/*` (Better Auth handler), `GET /v1/me`, `GET /v1/me/sessions`, `DELETE /v1/me/sessions/:id` |
| Orgs | `POST /v1/orgs`, `GET /v1/orgs`, `PATCH /v1/orgs/:id`, `POST /v1/orgs/:id/archive`, `POST /v1/orgs/:id/delete-request` |
| Members | `GET/POST /v1/members`, `PATCH /v1/members/:id` (role), `DELETE /v1/members/:id`, `POST /v1/invitations`, `DELETE /v1/invitations/:id` |
| Onboarding | `POST /v1/onboarding/sessions`, `POST /v1/onboarding/sessions/:id/answers`, `GET /v1/onboarding/sessions/:id/analysis`, `POST /v1/onboarding/sessions/:id/proposal` |
| Config | `GET /v1/config/versions`, `GET /v1/config/versions/:v/diff`, `POST /v1/config/versions/:v/apply`, `POST /v1/config/versions/:v/rollback` |
| Files & import | `POST /v1/files/uploads` (returns a signed upload URL, resumable), `POST /v1/files/:id/complete`, `POST /v1/imports`, `GET /v1/imports/:id`, `PUT /v1/imports/:id/mapping`, `POST /v1/imports/:id/run`, `POST /v1/imports/:id/rollback` |
| Work | `/v1/projects`, `/v1/tasks` (CRUD + `bulk`), `/v1/tasks/:id/comments` |
| CRM (imported) | `/v1/contacts`, `/v1/companies` |
| Library | `/v1/documents`, `/v1/documents/:id/versions`, `/v1/memory` (CRUD + `supersede`), `GET /v1/search?q=` |
| Dashboard | `GET /v1/dashboard` (widgets with `source` + `asOf`), `GET /v1/dashboard/metrics/:key/records` |
| Agents | `/v1/agents` (CRUD, clone, pause), `/v1/agents/:id/versions`, `GET /v1/agents/:id/runs` |
| Conversations | `POST /v1/conversations`, `GET /v1/conversations?q=`, `POST /v1/conversations/:id/messages` (→ `runId`), `POST /v1/runs/:id/cancel`, `GET /v1/runs/:id`, `GET /v1/runs/:id/stream` (SSE) |
| Approvals | `GET /v1/approvals?status=pending`, `GET /v1/approvals/:id`, `POST /v1/approvals/:id/decision` `{decision: approve|reject|request_changes, edits?}`. Accepted only from a human session; an agent token always gets 403. |
| Workflows | `/v1/workflows` (CRUD), `/v1/workflows/:id/versions`, `POST /v1/workflows/:id/publish`, `POST /v1/workflows/:id/dry-run`, `POST /v1/workflows/:id/enable|disable`, `GET /v1/workflow-runs/:id` |
| Integrations | `GET /v1/integrations` (catalog + truthful status), `POST /v1/integrations/:provider/connect` (→ OAuth URL with state + PKCE), `GET /v1/integrations/callback`, `POST /v1/integration-accounts/:id/test`, `DELETE /v1/integration-accounts/:id` |
| Audit & export | `GET /v1/audit?filter`, `POST /v1/exports` (job), `GET /v1/exports/:id` |
| Health | `GET /v1/health` (liveness), `GET /v1/health/ready` (DB, queue, storage; no secrets) |

## 3. Run stream (SSE) — `GET /v1/runs/:id/stream`

```
event: status        data: {"state":"thinking"}
event: token         data: {"text":"You have "}
event: tool.planned  data: {"stepId":"…","tool":"tasks.search","summary":"Find tasks due ≤ 21 Nov"}
event: tool.result   data: {"stepId":"…","ok":true,"summary":"4 tasks","refs":[{"type":"task","id":"…"}]}
event: approval.required data: {"approvalId":"…","risk":"low","action":"tasks.create","preview":{…}}
event: citation      data: {"refs":[{"type":"document","id":"…","title":"Sales Playbook","span":"§2"}]}
event: done          data: {"usage":{"inputTokens":812,"outputTokens":164,"costMinor":3,"currency":"USD"}}
event: error         data: {"code":"PROVIDER_UNAVAILABLE","retryable":true}
```

The client maps these events to Live AI states (03 §6). On reconnect it sends `Last-Event-ID`, and the server replays from a run event log kept for 15 minutes.

## 4. Event catalog (internal bus + WebSocket fan-out)

Channels are authorized per subscriber as `org:<org>:user:<user>` and `org:<org>:ws:<ws>`.

| Event | Payload essentials | Consumers |
| --- | --- | --- |
| `config.proposed` / `config.applied` / `config.rolled_back` | version, diff summary, actor | Home, audit |
| `import.progress` / `import.completed` / `import.failed` | jobId, counts, errors url | O3/O4 |
| `task.created` / `task.updated` / `task.overdue` | task ref | Work, workflows, notifications |
| `contact.created` | ref | Workflow triggers |
| `run.started` / `run.completed` / `run.failed` | runId, agent, outcome | Home activity, A5 |
| `approval.created` / `approval.decided` / `approval.expired` | id, risk, requester | Badge, P1, notifications |
| `workflow.run.started` / `.step` / `.completed` / `.failed` | runId, step | F2, notifications |
| `integration.status_changed` | provider, from→to, reason | I1, notifications |
| `security.alert` | kind, severity | S4, owner notification |
| `notification.created` | category, urgency | X3, push |

Every event envelope is `{ id, type, orgId, workspaceId?, occurredAt, correlationId, actor, data }`. Consumers are idempotent on `id`.
