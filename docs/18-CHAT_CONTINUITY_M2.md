# 18 — Chat continuity and context reuse (M2)

Run 2 of the Qline development plan (docs/17 §G). Two parts: reopening the AI chat continues the current
conversation, and the AI reuses what it already looked up in a conversation instead of repeating the same call.

## A. Resume and New Chat

**Before:** the app's AI chat (`LiveScreen`, opened from the shell without an id) started empty every time. A
conversation was created on the first message, so every reopen + message made a new conversation. History was only
reachable through the Conversations sheet.

**Now:**

- The app remembers one pointer per organisation + account (`chat.current.<orgId>.<email>` in secure storage): the
  id of the conversation last open, or `new` after you tapped New chat. No message content is stored on the device.
- On open: pointer = id → open it; pointer = `new` → stay on an empty chat; no pointer (first open, after sign-in) →
  open your most recent conversation. If the remembered one is gone or not yours (the API answers 404 for both), it
  falls back to the most recent one and says so. Network errors are not treated as "gone"; the usual retry banner shows.
- The pointer is written when a conversation is opened (on start or from history), when the first message creates
  one, and when New chat is tapped. A conversation is still only created when you send, so New chat never leaves
  empty conversations behind.
- New chat is explicit: the top-bar button (tooltip "New chat") and a "New chat" row at the top of the
  Conversations sheet. Both are disabled while an answer is being written.
- If an answer was still being written when the app closed (or the process was killed), reopening shows it and
  follows it to the end (`active_run` on `GET /conversations/:id`; the run's events are replayed). It is shown, not
  spoken.
- All chat pointers are removed on sign-out or when the session expires. Switching organisation uses a different
  pointer, so it never opens another organisation's conversation.

**Server fixes found while doing this:**

- A run left `running` or `queued` by a crash or a dropped connection blocked its conversation forever ("Already
  answering", 409). Runs still active after 5 minutes (answers are capped at 2) are now marked `failed` /
  "Interrupted" with a notice in the conversation, when the conversation is opened or a message is sent.
- `GET /conversations`, `GET /conversations/:id` and `POST /conversations/:id/messages` now also check the
  workspace, not only the user.

There is no delete or archive for conversations yet, so "deleted/archived" is covered by the 404 fallback.

## B. Context ledger

`conversation_context` (migration 0014) stores successful results of read-only tools, scoped to
**organisation + workspace + conversation + user + role**, with the tool, a hash of the arguments (keys sorted), the
summary, the data, the refs, the source tool call, when and under which database snapshot it was read, how long it
took and how many provider requests it made.

When the model calls the **same tool with the same arguments** again in that conversation, Qline answers from the
ledger if all of these hold:

1. **Not expired.** Per-tool expiry in `REUSE_POLICY` (`packages/policy`): 5–10 minutes for Qline data, 1–5 minutes
   for connected apps (Gmail search 60 s), at most 30 minutes (stored files).
2. **No change since in Qline data it depends on.** Statement-level triggers on 14 tables write one row per
   statement and organisation to `data_changes` with the writing transaction id. An entry is stale if any change to
   a table it depends on is not visible in the snapshot the read ran under (`pg_visible_in_snapshot`). This is exact
   — a change committed a moment after the read, or still in progress during it, counts — and it covers every write
   path (app, AI tools, imports, syncs, workflows, direct SQL), not only the ones that remember to say so. The read's
   own transaction is excluded (e.g. `knowledge.search` updates `last_used_at`).
3. **No Qline write since to the same connected app** (e.g. any `github.*` action invalidates `github.repos`).
4. **The user did not ask for fresh data** in this message: phrases like "refresh", "check again", "latest", "right
   now", Filipino "ulit" / "may bago", or `fresh: true` on `POST /conversations/:id/messages`. A fresh read replaces
   the saved one.

Not reused, ever: writes, failures, tools that show something in the chat (charts, images), and live state that
changes constantly (`time.now`, `approvals.list`, `agents.status`, `leads.list`, `business.snapshot`).

On reuse a normal `tool_calls` row is still written (status `succeeded`, `reused_context_id` pointing at the entry),
so the run's trace and audit stay complete; the chat shows the step as "… (from earlier in this chat, N min ago)";
the model gets the same summary and data plus `reused: {ageSec}`. The system prompt lists up to 10 still-valid
lookups of the conversation (tool, arguments, age, clipped summary; never the data) as untrusted data, so the model
repeats identical calls instead of new broader ones.

`GET /conversations/:id/context` returns the entries and measured savings: reused calls, provider requests avoided
(hits × requests the original read made), tool time avoided (hits × its duration) and result characters reused.
The scheduler tick purges expired entries (after 10 minutes) and change rows (after 2 hours).

### Honest limits

- **Changes made directly in a connected app** (a new email, an edited Drive file) are only covered by the short
  expiries. Qline cannot see them without asking the provider.
- **Tokens:** reuse saves provider requests, tool latency and rate limits. It does **not** reduce model tokens: the
  reused result is still sent to the model. The runner history still carries only user/assistant text (as before),
  so tool results from earlier messages are not resent; the ledger is how they are reused. Compacting verbose tool
  outputs (with the full result retrievable) was not done in this run.
- Savings were measured in tests (e.g. a repeated GitHub repo list: 2 provider requests avoided, 0 GitHub calls on
  the second read). No production numbers yet: migration 0014 is not applied to production.
- Invalidation is per table, not per row: a change to any task invalidates every saved task search in that
  organisation. Conservative by design.
- Requires PostgreSQL 13+ (`pg_snapshot`, `xid8`). CI uses 16 and local tests ran on 18. The production version
  was not checked in this run; check it before applying.

### Migration 0014

Adds `data_changes`, `conversation_context`, `tool_calls.reused_context_id`, the two functions and 42 triggers. All
additive. The down migration is in the file header. The API before M2 ignores all of it, so rolling the API back
without the down migration is safe. The triggers add one small insert per write statement on the 14 tables.

## Tests

- `services/api/test/context-ledger.integration.test.ts` (8, real Postgres with RLS): reuse across messages and the
  digest in the prompt; invalidation through the API and through direct SQL, not by unrelated tables; fresh phrase,
  fresh flag and expiry; isolation across conversations, users and organisations (RLS on the ledger and change log);
  connected-app reuse with zero provider requests and invalidation by a write to that app; `active_run` and
  stale-run recovery (the 409 deadlock); workspace filtering; purge.
- `services/api/test/unit.test.ts`: argument hashing (key order, nesting, undefined) and which tools are reusable.
- `packages/policy/test/policy.test.ts`: `REUSE_POLICY` covers only L0 reads, expiries ≤ 30 min, fresh phrases.
- `apps/mobile/test/m2_resume_test.dart` (12): resolve logic (remembered, new, none, gone, network error), pointer
  keys per org/account, clearing on sign-out, and the chat screen: reopen continues without creating a
  conversation, first open picks the latest, removed conversation falls back with a note, New chat is remembered.

Not covered by automated tests: following an in-progress answer after reopening on a device, and Android
process death on a real phone.
