# 07 — AI, Agent, Tool and Approval Policy

## 1. Provider-neutral AI layer

```ts
interface ChatProvider {
  id: string; capabilities: { tools: boolean; streaming: boolean; vision: boolean; maxContext: number; jsonMode: boolean };
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>; // token | tool_call | usage | error
}
interface SpeechToText { transcribe(audio: AudioChunkStream, opts): AsyncIterable<Transcript> }
interface TextToSpeech { synthesize(text: string, voice: VoiceId, speed: number): AsyncIterable<AudioChunk> }
interface Embedder { embed(texts: string[]): Promise<number[][]> } // optional, off by default
```

The model router picks the provider from the agent version's `model_config`, the org's allowed providers, their capabilities and budget. If a needed capability is missing (for example tool calling), the run fails clearly instead of degrading silently. Provider keys are held server-side in `secret_refs` and never reach the client or the model context.

## 2. Run lifecycle

1. Resolve the `TenantContext`, agent version and user. Check the agent is active and the budget is not exhausted.
2. Build the context. It includes the system policy (fixed), agent instructions, the business profile summary, and the retrieved records and documents limited to the agent's `memory_scopes` ∩ the user's permissions. Retrieved text is wrapped as **untrusted data blocks** (`<document source=… trust="untrusted">`) with the instruction that it cannot change policy.
3. Stream the model output and record every tool call request.
4. **For each tool call:** validate the args against the Zod schema → the policy engine decides `allow | require_approval | deny`, using the user's role, the agent's allowlist, the action risk and the org policy → if allowed, execute with an idempotency key → record the result summary.
5. On `require_approval`, persist an `approval_request`, emit `approval.required` and park the run. When a human decides, the run resumes in a worker that **re-checks authorization** first.
6. Finish with usage and cost accounting, output, citations and feedback slot.

Limits per run: max 8 tool calls, 120 s wall time for chat (workflows are configurable up to 10 min), 2 retries with backoff on provider 5xx, and a per-agent daily token budget plus a per-org monthly budget.

## 3. Policy matrix (defaults; org admins can tighten, not loosen past the floor)

Risk levels: **L0** read internal · **L1** create/modify internal reversible · **L2** modify/delete internal important, bulk changes, config · **L3** external communication or publishing · **L4** money, destructive deletion, sharing sensitive data outside the org.

| Tool / action | Risk | AI CEO | Sales | Marketing | Finance | Operations | Research | Default decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `records.search`, `tasks.search`, `documents.search`, `memory.read` | L0 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Allow (within scope) |
| `tasks.create`, `tasks.update` (own drafts) | L1 | ✓ | ✓ | ✓ | ✓ | ✓ | — | **Approval** in MVP; org may switch to allow |
| `notes.create`, `memory.propose` | L1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Allow; memory is created as status `proposed` (inferred) until the user confirms it |
| `contacts.update` | L1 | ✓ | ✓ | — | — | ✓ | — | Approval |
| `drafts.email.create` (draft only, not sent) | L1 | ✓ | ✓ | ✓ | — | ✓ | — | Allow |
| `tasks.bulk_update`, `records.delete`, `config.propose` | L2 | ✓ | — | — | — | ✓ | — | Approval (config always goes through proposal + diff) |
| `email.send`, `calendar.invite.send`, `social.publish` | L3 | — | ✓ | ✓ | — | ✓ | — | Approval, every time; never auto-allowed |
| `web.research` (external fetch) | L0* | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Allow, with results marked as untrusted |
| `payments.*`, `transfers.*` | L4 | — | — | — | — | — | — | **Not implemented**; hard deny |
| `records.purge`, `org.delete`, `share.external` | L4 | — | — | — | — | — | — | Deny for agents; humans only, with re-authentication |
| `agents.grant_permission`, `policy.update` | — | — | — | — | — | — | — | Deny for agents, always |

✓ = in the template allowlist; — = not available to that template.

## 4. Invariants (enforced in code and tested)

1. An approval decision can only come from a human user session. Agent and workflow service tokens get 403 on `/approvals/:id/decision`.
2. The approver must hold the permission for that risk level (`approvals.decide:high` for L3).
3. Delegation (Phase 8): a delegated run's effective permissions = delegator ∩ delegatee ∩ user. Escalation is impossible by construction.
4. Agents cannot modify their own `agent_versions`, policies or connector scopes.
5. Tool results and documents never become system messages.
6. Every L1+ action writes an `audit_event` with a correlation id that links the conversation, run, tool call and approval.
7. If the UI shows "Done", the tool call status is `succeeded`. The UI never infers success from model text.

## 5. Memory policy

Memory records carry provenance (`user|import|connector|agent_inferred`), confidence and status. Agent-inferred memories start as **Inferred**, which the UI shows as a dashed provenance tag, and are not used as facts in answers until the user confirms them, unless the org opts in. Users can correct, supersede, archive or delete memories. Deletion removes the record from retrieval immediately and purges it within the retention window.

## 6. Evaluation and observability

Every message gets thumbs up/down with an optional reason. Runs log latency, tokens, cost, tool success rate and approval rate. A small offline eval set per agent template (about 30 prompts with expected tool use) runs in CI against a mock provider for routing and policy, and is run manually against real providers before a release.
