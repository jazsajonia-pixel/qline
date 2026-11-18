# 09 — Integrations Hub and Feasibility Matrix

## 1. Connector framework

```ts
interface Connector {
  id: 'google-drive' | 'gmail' | 'google-calendar' | 'slack' | 'notion' | 'github' | 'stripe' | string;
  auth: { kind: 'oauth2-pkce' | 'api-key' | 'oauth2'; scopes: ScopeSet };
  capabilities: Capability[];             // e.g. 'drive.files.read', 'gmail.threads.read', 'gmail.drafts.create'
  test(account): Promise<HealthResult>;   // real API call, no side effects
  sync?(account, cursor): AsyncIterable<SyncedRecord>;
  webhook?: { verify(req): boolean; parse(req): ConnectorEvent[] };
  actions: Record<string, ToolDefinition>; // registered into the tool registry with a risk level
}
```

- **Truthful status** is computed, never set by hand. The value is **Not configured** until an account exists, **Connected** only after `test()` passes, **Needs attention** when a token refresh fails, scopes are insufficient or the last sync failed, and **Disconnected** after revocation. **Planned** is used for catalogue items without an implementation.
- The OAuth flow uses PKCE plus a signed `state` (bound to org, user and nonce, with a 10-minute expiry). The callback validates `state` and redirect URI and stores tokens through envelope encryption.
- Per-connector settings control which workspaces and **which agents** may use it, each with a subset of its capabilities.
- Revocation removes stored tokens, calls the provider's revoke endpoint where one exists and emits `integration.status_changed`.

## 2. Feasibility matrix

The required verification for every row: check current API docs, scopes, quotas and app-review requirements before building, and get the owner's approval before registering any OAuth app.

| Provider | First capability | Auth | Key constraints / risks | Phase | Feasibility |
| --- | --- | --- | --- | --- | --- |
| Google Drive | **v1.6: built.** Search and read any file the account can open; create/update only files Qline made | OAuth; `drive.readonly` + `drive.file` (feature "Drive files") | `drive.readonly` is restricted: Testing-mode test users only until Google verification + CASA | done | High in Testing; publishing needs verification |
| Gmail | Read threads, summarize, create drafts; send behind approval | OAuth | `gmail.readonly`/`gmail.modify` are restricted scopes and need verification and an annual security assessment for production; up to 100 test users before verification | 6 | Medium (process cost) |
| Google Calendar | Read events; create events behind approval | OAuth | `calendar.events` is a sensitive scope (verification, lighter than restricted) | 6 | High |
| Slack | Read selected channels, post behind approval | OAuth (Slack app) | Workspace admin may need to approve the app; rate limits per method | 8 | High |
| Notion | **v1.6: built.** Search/read shared pages; create pages and append blocks (approval) | OAuth public integration, `owner=user`, Notion-Version `2026-03-11` | Only pages the user picks; block text only (no tables/media) | done | High |
| GitHub | **v1.6: built.** List repos, issues, PRs; open issues and comment (approval). Never changes code | GitHub App, expiring user tokens | Only repos where the app is installed; no webhooks yet | done | High |
| Stripe | **v1.6: built.** Balance/charges/invoices summary and lists; create customers and **draft** invoices (approval, `auto_advance=false`) | Restricted key (`rk_` only, `sk_` refused) | No charges, refunds, transfers or sending invoices; no webhooks yet | done | High |
| Social (Meta, X, LinkedIn, TikTok) | Scheduling and analytics | Varies | App review, frequent policy changes, per-platform limits; never promise universal publishing | 7+ | Low–medium; review per platform |
| Messaging (WhatsApp, Messenger, Viber) | — | Business APIs only | Personal messaging access is not available through supported APIs; shown as **Unsupported** | — | Unsupported for personal accounts |

The Google scope classifications above (restricted/sensitive) reflect Google's policy as commonly documented. **Re-verify them against Google's current OAuth scope policy before registering the app.** They decide how much verification work Gmail needs.

### v1.6 agent tools and risk levels

| Tool | Risk | Decision | Agents |
|---|---|---|---|
| `knowledge.search` | L0 | allow | all |
| `knowledge.propose`, `knowledge.link` | L1 | allow (entries start unconfirmed; links marked "Added by AI") | all |
| `drive.search`, `drive.read` | L0 | allow | all |
| `drive.save_to_library` | L1 | allow | all except Research |
| `drive.create`, `drive.update` | L2 | approval (relaxable by autonomy level) | all except Research |
| `notion.search`, `notion.read` | L0 | allow | all |
| `notion.create`, `notion.append` | L2 | approval (relaxable) | all except Research |
| `github.repos`, `github.issues`, `github.read` | L0 | allow | all |
| `github.issue.create`, `github.issue.comment` | L3 | approval, never automatic | CEO, Operations |
| `stripe.summary`, `stripe.list` | L0 | allow | all |
| `stripe.customer.create`, `stripe.invoice.draft` | L3 | approval, never automatic | CEO, Finance, Sales |

Source: `packages/policy/src/index.ts`. Content returned by every connector is wrapped as untrusted data before the model sees it.

## 3. Integration UX rules

- The catalogue shows status pills with an icon and a word. It never shows a "Connected" badge on a static mockup in production.
- Each connector's detail screen shows the scopes in plain language ("Read emails you choose"), last sync, errors with a fix action, which agents can use it, and **Test connection** and **Disconnect** controls.
- Qline never asks users to paste secrets into chat. API keys go into a dedicated masked field and are stored server-side.


## Google Forms publish state (M1)

Forms created through the API after 2026-06-30 start unpublished. Qline publishes each new form and then reads it back; it only calls a form ready when Google reports it is published and accepting responses. Otherwise the result carries `accepting:false` and `publishError`, and the user is told to open the form and press Publish. Reading responses uses `drive.file`, which only covers forms Qline created. See docs/17 §C.
