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
| Google Drive | Pick and import files (read-only) | OAuth; prefer `drive.file` via Google Picker to avoid restricted scopes | Broad `drive.readonly` is a restricted scope and needs Google verification plus a security assessment | 2 | High with `drive.file` |
| Gmail | Read threads, summarize, create drafts; send behind approval | OAuth | `gmail.readonly`/`gmail.modify` are restricted scopes and need verification and an annual security assessment for production; up to 100 test users before verification | 6 | Medium (process cost) |
| Google Calendar | Read events; create events behind approval | OAuth | `calendar.events` is a sensitive scope (verification, lighter than restricted) | 6 | High |
| Slack | Read selected channels, post behind approval | OAuth (Slack app) | Workspace admin may need to approve the app; rate limits per method | 8 | High |
| Notion | Import selected pages and databases | OAuth (public integration) | The user grants per-page access; block-level parsing effort | 8 | High |
| GitHub | Read issues/PRs into tasks | GitHub App | Fine-grained installation permissions; webhooks with signature verification | 8 | High |
| Stripe | Read-only payments and events for Finance | Restricted API key or Stripe Connect OAuth | Read-only keys only; **no charges or transfers**; webhooks need signature checks | 7 | High (read-only) |
| Social (Meta, X, LinkedIn, TikTok) | Scheduling and analytics | Varies | App review, frequent policy changes, per-platform limits; never promise universal publishing | 7+ | Low–medium; review per platform |
| Messaging (WhatsApp, Messenger, Viber) | — | Business APIs only | Personal messaging access is not available through supported APIs; shown as **Unsupported** | — | Unsupported for personal accounts |

The Google scope classifications above (restricted/sensitive) reflect Google's policy as commonly documented. **Re-verify them against Google's current OAuth scope policy before registering the app.** They decide how much verification work Gmail needs.

## 3. Integration UX rules

- The catalogue shows status pills with an icon and a word. It never shows a "Connected" badge on a static mockup in production.
- Each connector's detail screen shows the scopes in plain language ("Read emails you choose"), last sync, errors with a fix action, which agents can use it, and **Test connection** and **Disconnect** controls.
- Qline never asks users to paste secrets into chat. API keys go into a dedicated masked field and are stored server-side.
