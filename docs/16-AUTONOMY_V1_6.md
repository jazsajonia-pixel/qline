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

## Deploy order

1. Merge PR #15 (Slack fixes). Then merge this PR.
2. Apply migration `0010_v16_autonomy.sql` to production.
3. Deploy the API, then release the APK.
