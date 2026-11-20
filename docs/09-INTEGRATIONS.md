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
| GitHub | **v1.10: built.** Browse repos, read and search code, branches, commits, PRs and CI; create working branches, commit files, open/edit/review PRs, open issues and comment (each write needs approval with a diff). Never pushes to the default or a protected branch, merges, force-pushes, changes workflows or reads secrets. See [docs/24](24-GITHUB_INTEGRATION.md) | GitHub App, expiring user tokens | Only repos where the app is installed; no webhooks yet | done | High |
| Stripe | **v1.6: built.** Balance/charges/invoices summary and lists; create customers and **draft** invoices (approval, `auto_advance=false`) | Restricted key (`rk_` only, `sk_` refused) | No charges, refunds, transfers or sending invoices; no webhooks yet | done | High |
| Facebook Pages | Publish supported Page text/image/video formats; reconcile status and available insights | Meta OAuth; Page access token | Page task eligibility; `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`; app review for production | CS-7 | Not implemented; feasibility depends on Meta review |
| Instagram Professional | Publish supported Professional-account media/Reels and reconcile status/insights | Meta Instagram Login or supported Facebook Login | Professional account eligibility; `instagram_business_basic`, `instagram_business_content_publish`; publishing limits and app review | CS-7 | Not implemented; verify account path and formats |
| YouTube | Resumable video upload, metadata, supported scheduling and status/analytics | Google OAuth | `youtube.upload` or appropriate scopes; quota, processing and API compliance | CS-8 | Not implemented; quota/review required |
| TikTok | Creator info, draft upload or Direct Post, status polling | TikTok OAuth / Content Posting API | Approved `video.publish`; unaudited clients are private-only; audit and verified URL requirements | CS-9 | Not implemented; approval/audit gate required |
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

Social capability status at Qline v1.9.0: none of Facebook Pages, Instagram Professional, YouTube or TikTok has a native OAuth/publishing implementation yet. The rows above are roadmap requirements, not available connectors. The parent plan and tenant-safe Creator Studio workflow are in [docs/25](25-CREATOR_STUDIO_FRAMEWORK_AND_ROADMAP.md).

## 3. Integration UX rules

- The catalogue shows status pills with an icon and a word. It never shows a "Connected" badge on a static mockup in production.
- Each connector's detail screen shows the scopes in plain language ("Read emails you choose"), last sync, errors with a fix action, which agents can use it, and **Test connection** and **Disconnect** controls.
- Qline never asks users to paste secrets into chat. API keys go into a dedicated masked field and are stored server-side.


## Google Forms publish state (M1)

Forms created through the API after 2026-06-30 start unpublished. Qline publishes each new form and then reads it back; it only calls a form ready when Google reports it is published and accepting responses. Otherwise the result carries `accepting:false` and `publishError`, and the user is told to open the form and press Publish. Reading responses uses `drive.file`, which only covers forms Qline created. See docs/17 §C.

## Google Drive for Content Studio (v1.9)

Content Studio coordinates video edits with an outside editor through Drive. See [docs/22](22-CONTENT_HANDOFF_BASELINE.md) and the editor spec in [docs/23](23-EDITOR_HANDOFF_SPEC.md).

- **Scopes are unchanged:** `drive.readonly` + `drive.file`. Qline never asks for the full `drive` scope.
- **Read-only in practice.** Calls used: `files.get`, `files.list` (children of mapped folders only), `alt=media` downloads of result files (≤ 256 KB), `changes.getStartPageToken`, `changes.list`, and, only when `QLINE_DRIVE_WEBHOOK_URL` is set, `changes.watch` and `channels.stop`. No file is created, changed, moved, shared or deleted.
- **Boundary.** Everything is limited to one main folder and the folders mapped inside it, by ID. Shortcuts are never followed. Indexing is bounded (depth 8, 5,000 items per sync).
- **Change tracking.** A changes cursor with a lease, re-listing on folder moves, a full re-listing on a stale cursor, retries with backoff on 429/5xx/403, and a 10-minute reconciliation tick that also expires old jobs and flags quiet ones.
- **Trust.** Editor reports are strict, size-capped, never given to a model and never move a job to "checked". Only Qline's own Drive reads verify a video.
- **Not done:** Qline does not write the manifest, PDF or receipt into Drive (the owner sends them); a push channel needs a public HTTPS address and was not tested with Google.
