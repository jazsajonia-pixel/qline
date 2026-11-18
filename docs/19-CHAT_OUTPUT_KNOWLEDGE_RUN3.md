# 19 — Chat output, knowledge in the chat, Back exit (run 3)

Run 3 of the Qline development plan (docs/17 §G): M3 (Markdown, collapsed activity trace, unknown-action UI),
M4 (knowledge canvas, in-chat Knowledge toggle, context transparency) and M5 (Android Back exit). No migration.

## A. M3 — answers and the activity trace

**Markdown** (`apps/mobile/lib/ui/markdown.dart`, own renderer). `flutter_markdown` is discontinued, so Qline
parses a small, safe subset itself: headings, paragraphs, bold/italic/inline code, bullet and numbered lists, quotes,
fenced code, links and simple tables. Raw HTML is shown as text, never rendered. Links only open for `http(s)`, after a confirm that shows the full address. While an answer is still streaming,
half-written syntax never shows as raw markers: an open `**` is held back, an open code fence is already a code
block, and a table header waits until its separator row arrives. Tool identifiers that slip into the
answer (`gmail.send`, `drive_search`) are replaced with friendly names. The system prompt also tells the model not
to name tools and to use simple Markdown.

**Collapsed trace** (`apps/mobile/lib/ui/activity_trace.dart`). The steps of an answer collapse into one line with
the overall status: Running, Completed, Waiting for approval, Failed or Needs attention. Tap to expand. Approvals,
failures, steps that change something (risk above L0) and "needs checking" results always stay visible, even collapsed.
Older answers load their steps on demand from `GET /runs/:id`, which now returns friendly labels built from the
policy preview (arguments are stripped; no secrets). Semantics labels describe the status for screen readers.

**Unknown outcome UI** (`screens/needs_checking.dart`). The M1 "unknown" actions (sent but no confirmation) are
listed under "N actions need checking" on Approvals. Each one shows what was attempted (`GET /actions/unknown` now
adds `title` and `lines`) and can be marked done or not done, with a confirm.

## B. M4 — knowledge canvas and knowledge in the chat

**Canvas** (`screens/knowledge_graph.dart`): pan and pinch zoom on an unbounded canvas, Zoom in / Zoom out / Fit to
screen / Reset layout buttons, long-press to drag a node (a plain drag pans, so panning stays easy), search, type
filters, "Connected only", focus on a node with its neighbourhood (others dimmed), a list view as the accessible
alternative, and loading / empty / error / no-match states. Level of detail in three steps (below 0.45×, up to 1.1×, above): zoomed out only categories, the selection and its
neighbours keep labels; at normal zoom all labels show on small maps (≤ 60 items); zoomed in all labels. Overlapping
labels are skipped.

Positions you drag are saved per organisation and view in secure storage (`qline.kgpos.<org>.<view>`), at most 300
nodes; Reset layout clears them. They are a device preference, not shared data.

**Knowledge toggle**: a Knowledge button sits left of the composer. It opens the map in a sheet over the chat (the
chat stays underneath). "Add to chat" puts an entry in the message as a chip; at most 5 per message.

**Context transparency**: the chips show what will be used ("Using X in this message", removable). Sent messages
show "Using knowledge: …". On the server, `POST /conversations/:id/messages` accepts `knowledge: uuid[]` (max 5),
requires `memory.read`, loads each entry under row-level security (another organisation's or unknown ids → 404) and
gives it to the model once, wrapped as untrusted context (`knowledge:<id>`), so instructions inside notes are not
followed. The ids and titles are stored on the message (`meta.knowledge`).

**AI memory saves** stay L1 "propose" steps: they appear in the trace like any other step and the entry can be
confirmed, edited or deleted from the knowledge screens. Nothing new is saved silently.

## C. M5 — Android Back

On the root shell, Back on another tab goes to Home; Back on Home asks "Close Qline?" (Stay / Exit, Stay focused).
A second Back while it is open closes the dialog; it never stacks a second one. Pushed screens, sheets and dialogs
keep normal Back. Leaving the AI chat with an upload in progress or unsent text asks "Leave the chat?" first.
Listening stops when the chat closes; answers keep being written on the server (run 2 resume).

## D. Fixes found on the way

- Tab FABs in the shell's `IndexedStack` shared the default hero tag, which asserted when a screen was pushed. They
  now use `heroTag: null`.
- The canvas zoom read `getMaxScaleOnAxis()` after `scaleByDouble(s, s, 1, 1)`; with z not scaled that returns 1, so
  level of detail and zoom limits were wrong. z is now scaled too.
- `Speaker` created its native audio player at construction, so sending a message (which stops any playback)
  touched the player even when nothing had played. The player is now created on first playback.

## E. Tests

- API: `packages/policy/test/labels.test.ts` (friendly names), `services/api/test/run3.integration.test.ts`
  (knowledge reaches the model once as untrusted context; cross-org, unknown and more than 5 ids refused; labels in
  the stream and the run record).
- Mobile: `test/m3_markdown_test.dart` (12: parsing, unsafe links, streaming, tool names) and
  `test/m3_run3_test.dart` (12: trace status and expansion, approvals never hidden, needs-checking, canvas filters /
  search / positions / reset, Knowledge toggle left of the composer and adding/removing context, Back exit).

Not verified: anything on a real device (gestures, performance on large graphs, the system Back gesture, TalkBack).
