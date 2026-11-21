# 30 — Live conversation with Qline's on-device voice (v1.12)

Status: implemented and covered by automated tests. **Not yet tested on a real phone** (no device in the build sandbox). Everything below marked "measured" was measured in the sandbox, not on Android hardware.

## 1. What this adds

| Requirement | How |
|---|---|
| Natural voice | A neural TTS model (Supertonic 3, int8) runs inside the app through sherpa-onnx. No external TTS app, no paid API, no Gemini. |
| Faster responses | The server streams the spoken part of the reply token by token (`say: true`). The app cuts it into clauses/sentences, synthesises each on the phone in a background isolate and queues it for gap-free playback while the rest is still being generated. |
| Real-time conversation | One microphone stream for the whole conversation. Silero VAD (on-device) finds the start and end of each turn; the end-of-turn wait adapts to dangling words (450–2200 ms). Turns go through the normal chat run, with the same tools, approvals and context. |
| Instant interruption | Talking over Qline stops the audio at once (native flush of the AudioTrack queue), drops every queued chunk, opens the recogniser with the audio from just before, and — once real words or sustained speech confirm it — cancels the run on the server (`POST /runs/:id/cancel {heard, reason:'barge_in'}`). The next turn is sent only after the cancel is acknowledged. |

This is **STT → LLM → TTS**, pipelined. It is not speech-to-speech.

## 2. Architecture choice

- **(A) Local pipeline — chosen.** Phone speech service for recognition, Qline's normal AI run, on-device neural TTS. Free after the model download, works with every provider Qline already supports, keeps tools/approvals, no secrets on the phone.
- **(B) Realtime speech-to-speech (OpenAI Realtime / Gemini Live) — not implemented.** Needs a paid or quota-limited key per minute of audio, a server relay to keep keys off the phone, and bypasses Qline's own tool/approval runner. It can be added later as an opt-in engine; (A) stays the fallback.

## 3. Components

| Layer | Files |
|---|---|
| Server | `services/api/src/agents/runner.ts` (pipelined live emitter, `say` tokens, `done.timing`, real cancellation, abort skips unstarted tools), `meta.ts` (`liveVoiceInstructions`, `<qline-screen>` split), `routes/agents.ts` (`POST /runs/:id/cancel`, owner only) |
| Android native | `LiveAudio.kt` (AudioRecord with VOICE_COMMUNICATION + AcousticEchoCanceler/NoiseSuppressor when available, AudioTrack playback queue with flush and "heard ms", SpeechRecognizer fed from the same stream on Android 13+ with fallback, audio focus), `LiveService.kt` (foreground service `microphone|mediaPlayback`, "Qline is listening" notification with End) |
| Dart | `core/live_conversation.dart` (state machine, barge-in, timelines), `core/neural_voice.dart` (catalog, download/verify/unpack, isolate synthesis), `core/vad.dart`, `core/speech_text.dart` (chunker, text normaliser), `core/live_audio.dart`, `screens/live.dart`, `screens/voice_settings.dart` |

### Barge-in steps
1. Detect: strict VAD + level above an adaptive echo floor (×2 with AEC, ×3.5 without), held 256 ms (AEC) / 384 ms (no AEC).
2. Own audio vs user: echo floor is learned while Qline talks; AEC when the phone has it; words that match what Qline just said do not confirm.
3–4. Stop + flush: native flush returns the playing chunk and how much of it was heard.
5–6. Cancel: confirmed by fresh words or 900 ms of voice; otherwise after 1.4 s it is a false alarm and the reply resumes from the cut chunk. Cancel aborts the model stream; tools not yet started are skipped; a tool already running finishes (no blind retry or interruption of side effects). The streamed part of the interrupted reply is saved with `meta.interrupted` and `meta.heard`; on the next turn the model is told the reply was interrupted and what the user actually heard.
7–9. The recogniser was already listening (with 600 ms pre-roll); the new turn is sent with full context after the cancel completes.

## 4. TTS model evaluation (measured in sandbox, 2 vCPU Xeon, 2 threads)

| Model | Load | RTF (lower = faster) | First audio, 8 s sentence | Notes |
|---|---|---|---|---|
| **Supertonic 3 int8 (default)** | 0.66 s | 0.13–0.17 | 1.31 s | Most natural; names, "Dr. Reyes", numbers clear in Whisper round-trip |
| Supertonic 2 int8 (faster option) | 0.54 s | 0.06–0.08 | 0.59 s | Slightly flatter |
| Piper LibriTTS | 2.03 s | 0.21 | 0.12 s | Lexicon drops unknown words (names) |
| Kitten nano | 1.0 s | 0.27 | 1.66 s | Drops unknown words; robotic |
| Pocket TTS | 0.75 s | 0.55–0.75 | 3.75 s | Too slow on phone-class CPU |
| Kokoro 1.1 | 1.89 s | 1.18–1.6 | 3.65 s | Slower than real time here; drops words |

In live mode the first chunk is a short clause (≥4 words, ≤10), so first audio is roughly the synthesis time of a few words, not the whole sentence. **Phone numbers are unknown until "Settings → Voice → Benchmark this phone" is run on the TECNO KN8.**

## 5. Licences and sizes

| Component | Licence | Size |
|---|---|---|
| sherpa-onnx 2.x (Flutter package; 2.x has no GPL espeak-ng) | Apache-2.0 | native libs in APK |
| ONNX Runtime | MIT | in APK |
| Silero VAD v5 (bundled asset) | MIT | 644 KB |
| archive (Dart) | MIT | — |
| Supertonic 3 / 2 models (downloaded, not bundled) | OpenRAIL-M model licence with use restrictions (passed on in Terms §8) | 128.8 MB / 84.7 MB download, SHA-256 checked |

Models are kept in app-private storage (`voices/<id>`), can be deleted in Settings, and work offline after download.

## 6. Acceptance criteria

| # | Criterion | Verified by |
|---|---|---|
| 1 | Speech starts before the reply finishes generating | unit test "streamed reply is synthesised and queued while it is still arriving"; server integration test |
| 2 | Chunks play in order, no overlap, nothing lost | chunker tests; ordered seq queue |
| 3 | Barge-in flushes audio before the recogniser opens | unit test (call order `flush` < `listen`) |
| 4 | Old run's late tokens are never played | unit tests (stale reply, stale synth) |
| 5 | Next turn is sent only after the cancel finishes | unit test (cancel gate) |
| 6 | Echo of its own words does not confirm; false alarm resumes | unit tests |
| 7 | Server cancel is real (model aborted, unstarted tools skipped, owner only) | `voice-live.integration.test.ts` |
| 8 | Time to audible response < 1.5 s on the phone after end of turn | **not verified — needs device** |
| 9 | Voice stops < 150 ms after barge-in is detected | **not verified — needs device** |

## 7. Lifecycle

- Minimize / navigate: the foreground service keeps mic and playback alive; the notification has End.
- Stop button / tapping the core: stops the voice and cancels the run; the conversation keeps listening.
- End (bar or notification) / "stop listening": stops everything, releases the mic and the service.
- Sign out / screen disposed: the conversation is stopped.
- Process death: the conversation ends. It is not restored.

## 8. Metrics

Each turn and interruption records a timeline (`VoiceTimeline`): speech start, first partial, endpoint, final, sent, first spoken token, synthesis start/done, first audio, chunk gaps; for interruptions detect → stopped → confirmed → cancelled → next audio. The server adds `firstTokenMs`/`totalMs`. The last results are shown in Settings → Voice → "Last live conversation". No numbers are reported until they are measured.

## 9. Known limitations and risks

- No device testing yet: audio quality, echo cancellation and interruption reliability on the TECNO KN8 are unknown.
- Feeding the shared mic stream to Android's recogniser (`EXTRA_AUDIO_SOURCE`, Android 13+) may not be supported by every speech service; the app falls back to the recogniser's own microphone, which then pauses VAD during a turn.
- Phones without AcousticEchoCanceler rely on the louder-than-echo gate; loud speaker volume may still cause false barge-ins (they resume after 1.4 s). Settings has an "Interrupt by talking" switch and an "Echo cancellation" switch.
- The TTS is English only. Filipino and Taglish words are read with English pronunciation (tested: poor). Recognition still uses the phone's language setting.
- The first live turn after opening the app pays the model load (≈0.7 s measured in sandbox, likely more on phone).
- Model download is ~129 MB.
