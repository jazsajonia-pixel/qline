# 26 — Voice v2, background continuity and answer depth (v1.11)

Status labels used here: **Implemented** (code merged), **Tested** (automated tests in CI), **Device-verified** (checked on a real phone), **Production-verified** (checked against the live API).

## 1. Answer depth (server)

`SYSTEM_POLICY` in `services/api/src/agent/runner.ts` no longer says "Keep answers short and practical." It now asks for depth that matches the question: a direct answer first, then the context a capable colleague would add (why it matters, what it depends on, the main caveat, the next step), with no filler, preambles or recaps, and with uncertainty kept visible. The spoken line stays short (`META_INSTRUCTIONS`, about 35 words).

- Implemented, Tested (the integration test checks the policy reaches the model). The effect on answer quality is a prompt change and has to be judged on real conversations.

## 2. Voice v2

### Early spoken lines (streaming speech)
In a voice turn the model starts its reply with `<qline-say>One short sentence.</qline-say>`. `SayFilter` (`agent/meta.ts`) pulls each complete block out of the token stream, so it is never shown, and the runner emits a `speech` SSE event right away. The phone starts speaking while the written answer is still streaming. Before tool use the model may say what it is checking ("Let me check your tasks."). The stored `meta.speech` is what was said early. When the model ignores the instruction, the old path still works: the meta block's speech, or a brief of the text, is spoken at the end.

### Voice-aware prompting (accuracy, Filipino–English)
`POST /conversations/:id/messages` accepts `voice: { lang?, confidence?, alternates? }` (validated, stored in the message meta). The runner then adds `voiceInstructions()`:
- the text came from speech recognition and may contain mistakes;
- Taglish is normal: understand both languages and reply in the mix the user used;
- confirm unclear names, numbers, amounts, dates or actions before anything that changes data or sends something;
- the recogniser's alternates are passed as untrusted data (angle brackets removed).

### Phone (apps/mobile)
- **Listening language** (Voice settings → Listening): Phone default, English (Philippines), Filipino, English (US). `pickLocale()` maps it to an installed recogniser locale (Filipino is also published as `tl`). If it is missing, Qline says so and uses the phone default.
- **Barge-in** (hands-free, on by default, toggle "Interrupt by talking"): the mic stays open while Qline speaks. `isBargeIn()` ignores words that are part of what Qline is saying (echo) and needs two other words, or one interrupt word (stop, wait, teka, sandali, tama, hinto…). The voice then stops and the same recognition session carries on with the user's words (echo removed). If the written answer is still streaming, the new request is queued and sent when it finishes; the run is not cancelled.
- **End of turn**: Filipino connectors and fillers (at, pero, kasi, tapos, yung, ano, para…) count as "more is coming". The base silence is 1.3 s in hands-free and 1.1 s otherwise (was 1.5 / 1.3); re-listen after speech is 250 ms (was 450).
- The voice also queues lines (`Speaker.enqueue`), so several early lines play in order.

Implemented. Tested: server (unit and integration: speech event before tokens, voice meta stored, voice instructions only for spoken turns, say blocks stripped) and phone helpers (locale picking, echo filter, Filipino end-of-turn, settings persistence). **Not device-verified**: real recogniser behaviour on the TECNO KN8, Filipino speech packs, echo levels through the phone speaker, and whether the recogniser beeps when it reopens during barge-in. A realtime speech-to-speech provider is still a spike; this work stays inside the STT → agent → TTS pipeline.

## 3. Background continuity

- Live AI is a persistent layer of the shell (`screens/shell.dart`), not a pushed route. **Minimize** (the ⌄ button, or Android Back) hides it with `Offstage` and `TickerMode`; the answer stream, the voice, drafts and attachments keep going. **End Live AI** (the × button) disposes it, after asking if something is still running.
- **Orb flight**: on open and minimize the core flies between the live screen and the navbar orb (`Rect.lerp`, ease-out 450 ms in, ease-in 220 ms out) while the screen fades. Reduce motion jumps straight to the end state.
- **Navbar orb shows the real state** (`core/live_status.dart`): idle, listening, thinking (also tool work), speaking, needs approval, disconnected (errors and offline). It follows the voice level while minimized. Its screen-reader label says so ("Return to Live AI, thinking").
- **App in the background**: the answer and the voice keep going while Android keeps the process alive. The mic stops (Android does not let background apps listen). When an answer finishes in the background, a local notification says "Your answer is ready" (or "needs your approval"). On return, a dropped stream reconnects from the last event; hands-free starts listening again.
- **Dropped connections**: the stream reconnects from the last event up to 4 times with backoff, including when the server closes a replay after 150 s, instead of showing "connection dropped".
- Switching organisation ends Live AI.

Implemented. Tested: widget test (open → send → minimize mid-answer → the answer finishes while minimized → reopen shows it; no `/runs/:id/cancel` call; orb label follows the state; Back minimizes). **Not done**: an Android foreground service, so a long answer can be cut off if Android kills the app in the background. **Not device-verified**: the animation, background audio and notifications on a real phone.
