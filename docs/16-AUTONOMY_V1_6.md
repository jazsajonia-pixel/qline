# v1.6 — Opt-in autonomy, delegation and a voice that talks less

Status: implemented on branch `feat/v1-6-autonomy` (PR #16). Not merged and not deployed. The owner needs to approve it first.

## Autonomy levels

These are stored per workspace in `workspaces.config.agentPolicy.autonomy`. The default is `supervised`. Only roles with `config.apply` (owner and admin) can change the level, through `PUT /v1/workspaces/:id/autonomy`. Each change writes an `autonomy.changed` audit event, and agents cannot call this endpoint.

| Level | What runs without asking | Still asks first |
|---|---|---|
| supervised | Reads and drafts (L0–L1 that were already allowed) | Every data change and every external action |
| autopilot | L1 and L2 writes (tasks, contacts, companies, projects) and delegation to other agents | `records.delete`, L3 external actions (Slack, email), `config.propose` |
| full | Also L3 external actions and `records.delete`, up to `dailyExternalLimit` (default 25) in a rolling 24 hours | `config.propose`; anything over the daily limit |

No level overrides any of the following: L4 (money, roles, deleting the org, sharing outside Qline), `AGENT_DENY`, the emergency stop, pause, the agent's tool allowlist, or the caller's role permissions. All of this logic lives in `decideTool` in `packages/policy`. The daily limit counts L3 `tool_calls` that have `policy_decision='allow'` (see `autonomyState` in `services/api/src/core/controls.ts`).

## New tools

- `companies.update` and `projects.update` (L1). These run under RLS and are allowed without asking under autopilot or full.
- `slack.channel.create` and `slack.channel.topic` (L3, used by the CEO and operations agents). Creating a channel reuses an existing channel with the same name, and can optionally make the channel the default. These tools need the Slack scope `channels:manage`. Add it in the Slack app, then reconnect.
- `agents.delegate` (CEO only). It creates a single-task mission for another agent. Under supervised, the mission waits for plan approval. Under autopilot or full, it is approved automatically and starts in the background on the durable runtime. Tasks inside a mission can never delegate further.
- `agents.status` (CEO only, L0). It reports the state of delegated work.

## Auto agent

When the client sends `POST /agents/messages` with `agent: 'auto'`, `routeAgent` uses keyword routing to pick an agent. It falls back to the CEO on a tie or when nothing matches. The response includes the chosen agent, and Live shows it on the reply.

## Spoken line and suggestions

The model can end its reply with `<qline-meta>{"speech": "...", "suggestions": ["..."]}</qline-meta>`. The runner's `MetaFilter` strips this block from the token stream, so the user never sees it. The runner then emits a `meta` SSE event and stores the data in `conversation_messages.meta`, which is added by migration 0010. Live speaks only the `speech` line. If that line is missing, Live speaks the first one or two sentences, up to 220 characters (`spokenLine` in `voice.dart`). The suggestions appear as tappable chips under the reply.

## Voice animation sync

- With device TTS, the word clock starts when the engine reports it has started speaking. If that report has not arrived after 600 ms, the clock starts anyway.
- With cloud audio, the animation follows the player's actual position.
- The core's amplitude uses only the real level and the word pulse, smoothed with a fast attack and a slow release. There is no synthetic wobble.

## Run 2: files, charts and the new look

Status: implemented on branch `feat/v1-6-files-charts`, in a draft PR stacked on PR #16. It is not merged and not deployed.

### Files sent to the AI

The client calls `POST /v1/agents/attachments` (multipart field `file`, permission `agents.use`) as soon as a file is picked, then sends the message with `attachments: [ids]`. A message can carry up to 5 files. Its text may be empty when files are attached; it is then stored as "Please look at the attached file." An id that belongs to another workspace returns 404.

| Kind | How it is recognised | Limit | What is stored |
|---|---|---|---|
| Image (PNG, JPEG, WebP, GIF) | Magic bytes, not the file name | 5 MB | The bytes in object storage, `files.source='chat'`, `extracted.kind='image'` |
| Records (CSV, XLSX, JSON) | `detectFormat` + `parseFile` (the Imports parser) | 10 MB | Columns and up to 500 rows in `files.extracted` |
| Document (TXT, MD, PDF, DOCX) | Same parser | 10 MB | Up to 100,000 characters of text in `files.extracted` |

Each upload writes a `file.attached` audit event.

`GET /v1/files/:id/content` (`documents.read`) serves images only. It re-checks the magic bytes and sets `X-Content-Type-Options: nosniff`, so an uploaded file can never be served as HTML or script.

File contents reach the model as untrusted context, wrapped the same way as other tool data. Images are sent only with the latest user message, at most 4, and only when the model supports vision:

- **OpenAI-compatible providers:** `image_url` data-URI parts.
- **Anthropic:** base64 image blocks.
- **DeepSeek:** declares `vision: false`. It gets a note that an image was attached but cannot be seen, and the model is told to say so rather than guess.

### New AI tools

| Tool | Level | What it does |
|---|---|---|
| `files.read` | L0 | Pages through an attached file (8,000 characters or 50 rows per page) |
| `files.save_to_library` | L1 | Saves an attached document as a library note, so it becomes searchable memory |
| `files.import_records` | L2, asks first (relaxable by autopilot), needs `imports.run` | Imports attached rows into contacts, companies, tasks or leads (up to 500). It creates a normal `import_jobs` row in the same transaction, so the import shows up in Imports and can be rolled back. Only the CEO, sales, marketing and operations agents have it. |
| `chart.business` | L0 | Charts the workspace's own data, computed on the server. Nine metrics: leads per day, by source and by urgency; tasks by status, by priority and completed per week; contacts by stage and added per week; AI tokens per day. |
| `chart.create` | L0 | Charts numbers from elsewhere, such as an attached sheet or a Drive file. The input is validated (labels and series must line up) and a `source` is required. |
| `image.show` | L0 | Shows an attached or stored image again, with a caption |

Migration `0011_v16_files_charts.sql` adds `files.source` (`import` or `chat`, with a check constraint), `files.extracted` (jsonb) and an index. It also adds the tools to all current agent versions.

### Charts and images in chat

Tools return `artifacts`. The runner sends each one as an `artifact` SSE event (at most 6 per answer) and stores them in `conversation_messages.meta.artifacts`, so reopening a conversation shows them again. Live draws charts natively (`lib/ui/chat_artifacts.dart`), so no chart package is added:

- grouped bar, line and pie (donut) charts;
- a legend when there are several series;
- a source line: "Computed by Qline from your data" for `chart.business`, or "From: … · provided by the AI" for `chart.create`;
- a screen-reader summary that reads out the values;
- no grow-in animation under reduce motion.

Images load with the user's session, are cached in memory, and open full screen on tap.

In the composer, the paperclip opens the system picker. Size limits are checked before upload. Pending files appear as removable chips, and a failed send keeps them so they can be sent again. `ChatAttachments` holds this logic and is unit-tested.

### New palette and app icon

The palette is now "Citrine Signal on Spruce Ink"; tokens and contrast ratios are in docs/03 §2 (`apps/mobile/tool/contrast.py` recomputes them). The launcher icon is now drawn from the exact `QMark` geometry used in the app, by `apps/mobile/tool/make_icons.py`. It includes adaptive and monochrome layers. The old icon was a closed ring with a dot, which did not match the in-app mark. The website and the OAuth "connected" page use the new colours too.

### Test-only storage

When `NODE_ENV=test` and no S3 bucket is configured, the imports module uses an in-memory object store, so integration tests can run file flows. Production still requires S3; nothing changed there.

## Deploy order

1. Merge PR #15 (Slack fixes), then PR #16, then the run-2 PR.
2. Apply migrations `0010_v16_autonomy.sql` and `0011_v16_files_charts.sql` to production.
3. Deploy the API, then release the APK.
