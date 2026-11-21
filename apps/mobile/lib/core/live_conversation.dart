import 'dart:async';
import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';

import 'live_audio.dart';
import 'neural_voice.dart';
import 'speech_text.dart';
import 'voice.dart';

/// v1.12 (docs/30): a live, hands-free conversation with Qline's on-device voice.
///
/// One echo-cancelled microphone stream runs for the whole conversation. Voice activity detection
/// finds the start and end of each user turn; the recogniser is fed from that same stream (with the
/// audio from just before speech was detected). Replies are spoken while they stream: text arrives
/// in pieces, is cut into chunks, synthesised on the phone and queued for gap-free playback.
///
/// Barge-in: while Qline talks, louder-than-echo speech held for a moment stops the voice at once and
/// drops everything queued. If the recogniser then hears real words (not an echo of the reply) or the
/// speech keeps going, the reply is cancelled on the server with what the user actually heard, and the
/// new words become the next turn. Otherwise it was a false alarm and the reply resumes.
///
/// This is speech recognition → language model → speech synthesis, streamed. It is not a speech-to-speech model.
enum LiveVoiceState { off, starting, listening, userSpeaking, thinking, speaking, interrupted, reconnecting, error }

/// Voice activity for one 32 ms frame: [voice] is normal detection, [strict] the harder bar used for barge-in.
class VadResult {
  const VadResult(this.voice, this.strict);
  final bool voice, strict;
}

abstract class SpeechDetector {
  VadResult accept(Float32List frame);
  void reset();
}

/// Timings for one turn or one interruption, in ms from its start (docs/30 §8). Only measured values.
class VoiceTimeline {
  VoiceTimeline(this.kind, {int Function()? clock}) : _clock = clock ?? _wall() {
    _t0 = _clock();
  }
  final String kind;
  final int Function() _clock;
  late final int _t0;
  final marks = <String, int>{};
  int gaps = 0, gapMs = 0;
  Map<String, dynamic>? server;
  bool falseAlarm = false;

  static int Function() _wall() {
    final w = Stopwatch()..start();
    return () => w.elapsedMilliseconds;
  }

  int get now => _clock() - _t0;
  void mark(String k) => marks.putIfAbsent(k, () => now);
  int? between(String a, String b) => marks[a] != null && marks[b] != null ? marks[b]! - marks[a]! : null;

  Map<String, dynamic> toJson() => {'kind': kind, 'marks': marks, 'gaps': gaps, 'gapMs': gapMs, 'server': ?server, if (falseAlarm) 'falseAlarm': true};
}

class _Chunk {
  _Chunk(this.seq, this.reply, this.text, this.say);
  final int seq;
  final String reply, text, say;
  SynthAudio? audio;
  bool failed = false, queued = false, started = false;
}

class LiveConversation {
  LiveConversation({
    required this.engine,
    required this.detector,
    required this.synth,
    required this.onUtterance,
    required this.onBargeIn,
    this.onState,
    this.onCaption,
    this.onLevel,
    this.onTimeline,
    this.onEnd,
    this.onNotice,
    this.locale,
    this.aecRequested = true,
    bool inject = true,
    this.service = true,
    this.frameMs = 32,
    this.voice,
    this.speed,
    this.bargeIn = true,
  }) : _inject = inject; // ignore: prefer_initializing_formals

  final LiveAudioEngine engine;
  final SpeechDetector detector;
  final Synthesizer synth;

  /// The user finished a turn: send it as the next message (with `voice: {mode: 'live', ...}`).
  final Future<void> Function(String text, Map<String, dynamic> voice) onUtterance;

  /// The user talked over a reply: cancel it on the server, saying what they heard of it.
  final Future<void> Function(String heard) onBargeIn;
  final void Function(LiveVoiceState state)? onState;
  final void Function(String words)? onCaption;
  final void Function(double level)? onLevel;
  final void Function(VoiceTimeline t)? onTimeline;
  final void Function()? onEnd;
  final void Function(String message)? onNotice;
  final String? locale;
  final bool aecRequested, service;

  /// Talking over Qline interrupts it (Settings → Voice). Off: speech while Qline talks is ignored.
  final bool bargeIn;
  final int frameMs;
  int? voice;
  double? speed;

  // Tunables (docs/30 §6).
  static const preRollMs = 600, bargeHoldAecMs = 256, bargeHoldRawMs = 384, confirmVoiceMs = 900, falseAlarmMs = 1400, tailMs = 200;
  static const minBargeLevel = .02;

  LiveVoiceState state = LiveVoiceState.off;
  bool aec = false;
  bool _inject;
  bool get injecting => _inject;
  StreamSubscription<Map<String, dynamic>>? _sub;

  int _t = 0;
  final _ring = ListQueue<Uint8List>();
  int _quietUntil = 0;

  // ---- user turn ----
  bool _recognizing = false, _ending = false, _confirmed = true, _overReply = false, _barging = false;
  String _words = '';
  double? _conf;
  List<String> _alts = const [];
  int _lastVoice = 0, _lastWords = 0, _voiceMs = 0, _bargeAt = 0;
  bool _ready = false;
  Timer? _endTimer, _legacyTimer;
  VoiceTimeline? _turn, _lastTurn, _barge;

  // ---- reply ----
  String? _reply;
  final _chunker = SpeechChunker();
  final _chunks = <_Chunk>[];
  int _seq = 0, _queuedNative = 0, _gapAt = -1;
  bool _replyClosed = false, _replyDone = false, _synthRunning = false, _held = false, _playing = false;

  // ---- barge-in ----
  double _echo = .004;
  int _bargeMs = 0;
  int _resumeFrom = -1;
  String _heard = '';

  bool get speaking => _playing || _queuedNative > 0;
  String? get reply => _reply;

  void _set(LiveVoiceState s) {
    if (state == s) return;
    state = s;
    onState?.call(s);
  }

  Future<bool> start() async {
    _set(LiveVoiceState.starting);
    _sub = engine.events.listen(_onEvent);
    final r = await engine.start(aec: aecRequested, service: service);
    if (r['ok'] != true) {
      onNotice?.call(r['error'] == 'microphone' ? 'Qline needs the microphone for a live conversation.' : 'The microphone could not start.');
      _set(LiveVoiceState.error);
      return false;
    }
    aec = r['aec'] == true;
    if (r['inject'] != true) _inject = false;
    _set(LiveVoiceState.listening);
    return true;
  }

  /// Ends the conversation: the voice stops, the microphone closes, nothing pending survives.
  Future<void> stop() async {
    _endTimer?.cancel();
    _legacyTimer?.cancel();
    _reply = null;
    _chunks.clear();
    _chunker.reset();
    _recognizing = false;
    _playing = false;
    _queuedNative = 0;
    await _sub?.cancel();
    _sub = null;
    try {
      await engine.stop();
    } catch (_) {}
    _set(LiveVoiceState.off);
  }

  // ---- events ---------------------------------------------------------------------------------------
  void _onEvent(Map<String, dynamic> e) {
    switch (e['type']) {
      case 'mic':
        _onFrame(e['pcm'] as Uint8List);
      case 'rready':
        _ready = true;
      case 'partial' || 'final':
        _onWords(((e['texts'] as List?) ?? const []).whereType<String>().toList(), (e['confidence'] as num?)?.toDouble(), e['type'] == 'final');
      case 'rerror':
        _onRecognizerError((e['code'] as num?)?.toInt() ?? -1);
      case 'rend':
        if (_recognizing) _commit();
      case 'started':
        _onStarted((e['seq'] as num).toInt());
      case 'ended':
        if (_queuedNative > 0) _queuedNative--;
      case 'drained':
        _onDrained();
      case 'focus':
        if (e['state'] == 'loss' || e['state'] == 'transient') {
          // A phone call or another app took the audio: stop talking, keep the conversation.
          unawaited(_flushVoice());
          onNotice?.call('Paused for another app’s audio.');
        }
      case 'end':
        onEnd?.call();
      case 'error':
        onNotice?.call(e['message'] as String? ?? 'Audio error');
        if (e['where'] == 'mic') _set(LiveVoiceState.error);
    }
  }

  /// Feeds one microphone frame (also used by tests).
  void feedFrame(Uint8List pcm) => _onFrame(pcm);

  void _onFrame(Uint8List pcm) {
    _t += frameMs;
    _ring.addLast(pcm);
    while (_ring.length * frameMs > preRollMs) {
      _ring.removeFirst();
    }
    final f = pcm16ToFloat(pcm);
    final level = rms(f);
    onLevel?.call(level);
    final v = detector.accept(f);

    if (_playing && !_held && !_recognizing) {
      if (!bargeIn) return;
      // Qline is talking: only clearly-louder-than-echo speech, held for a moment, counts as the user.
      if (!v.voice) _echo = _echo * .95 + level * .05;
      final gate = math.max(minBargeLevel, _echo * (aec ? 2.0 : 3.5));
      final cand = v.strict && level > gate;
      _bargeMs = cand ? _bargeMs + frameMs : math.max(0, _bargeMs - frameMs);
      if (_bargeMs >= (aec ? bargeHoldAecMs : bargeHoldRawMs)) {
        _bargeMs = 0;
        unawaited(_tentativeBarge());
      }
      return;
    }
    if (!_recognizing) {
      if (v.voice && (_t >= _quietUntil || v.strict) && state != LiveVoiceState.off && state != LiveVoiceState.error) unawaited(_userStarted(barge: false));
      return;
    }
    if (v.voice) {
      _lastVoice = _t;
      _voiceMs += frameMs;
    }
    if (!_confirmed) {
      if (_voiceMs >= confirmVoiceMs) {
        unawaited(_confirm());
      } else if (_t - _bargeAt >= falseAlarmMs && _voiceMs < 300 && _freshWords().isEmpty) {
        unawaited(_falseAlarm());
        return;
      }
    }
    if (!_ending && _voiceMs >= 160 && _t - math.max(_lastVoice, _lastWords) >= liveEndpointMs(_words)) _endTurn();
  }

  // ---- user turns -----------------------------------------------------------------------------------
  Future<void> _userStarted({required bool barge}) async {
    _recognizing = true;
    _ending = false;
    _ready = false;
    _words = '';
    _conf = null;
    _alts = const [];
    _voiceMs = barge ? (aec ? bargeHoldAecMs : bargeHoldRawMs) : frameMs;
    _lastVoice = _t;
    _lastWords = _t;
    _bargeAt = _t;
    _barging = barge;
    _overReply = _reply != null;
    _confirmed = !_overReply;
    _turn = VoiceTimeline('turn')..mark('speech');
    _set(barge ? LiveVoiceState.interrupted : LiveVoiceState.userSpeaking);
    final pre = BytesBuilder(copy: false);
    for (final p in _ring) {
      pre.add(p);
    }
    try {
      final r = await engine.listen(locale: locale, preRoll: pre.takeBytes(), inject: _inject);
      if (!r.ok) {
        _recognizing = false;
        onNotice?.call('Speech recognition is not available on this phone.');
        _set(LiveVoiceState.error);
        return;
      }
      if (_inject && !r.inject) _inject = false;
      if (!_inject) _armLegacy();
    } catch (e) {
      _recognizing = false;
      onNotice?.call('Speech recognition failed to start.');
    }
  }

  /// Without the shared microphone the recogniser owns the mic, so turn ends and false alarms use timers.
  void _armLegacy() {
    _legacyTimer?.cancel();
    _legacyTimer = Timer(Duration(milliseconds: liveEndpointMs(_words) + (_words.isEmpty ? 2500 : 400)), () {
      if (!_recognizing) return;
      if (!_confirmed && _freshWords().isEmpty) {
        unawaited(_falseAlarm());
      } else {
        _endTurn();
      }
    });
  }

  String _spokenSoFar() => _chunks.where((c) => c.queued).map((c) => c.text).join(' ');

  String _freshWords() => _overReply ? withoutEcho(_words, _spokenSoFar()) : _words;

  void _onWords(List<String> texts, double? conf, bool isFinal) {
    if (!_recognizing || texts.isEmpty) {
      if (isFinal && _recognizing) _commit();
      return;
    }
    final w = texts.first.trim();
    if (w.isNotEmpty) {
      _conf = conf ?? _conf;
      _alts = texts.skip(1).where((x) => x.trim().isNotEmpty).take(3).toList();
    }
    if (w.isNotEmpty && w != _words) {
      _words = w;
      _lastWords = _t;
      _turn?.mark('partial');
      final fresh = _freshWords();
      if (fresh.isNotEmpty) onCaption?.call(fresh);
      if (!_confirmed && (fresh.isNotEmpty && (isBargeIn(_words, _spokenSoFar()) || wordsOf(fresh).isNotEmpty))) unawaited(_confirm());
      if (!_inject) _armLegacy();
    }
    if (isFinal) _commit();
  }

  void _onRecognizerError(int code) {
    if (!_recognizing) return;
    // The shared-microphone recogniser is not supported on this phone (it failed before it was ready):
    // switch to the recogniser's own microphone for the rest of the conversation.
    if (_inject && !_ready && _words.isEmpty) {
      _inject = false;
      _recognizing = false;
      onNotice?.call('Using the standard recogniser on this phone.');
      unawaited(_userStarted(barge: _barging));
      return;
    }
    _commit();
  }

  void _endTurn() {
    if (_ending || !_recognizing) return;
    _ending = true;
    _turn?.mark('endpoint');
    _set(LiveVoiceState.thinking);
    unawaited(engine.endListen());
    _endTimer?.cancel();
    // Some recognisers never send a final result: use the last words heard.
    _endTimer = Timer(const Duration(milliseconds: 1500), () {
      if (_recognizing) _commit();
    });
  }

  static final _stop = RegExp(r"^(please )?(stop listening|end (the )?(call|conversation)|that'?s all|goodbye|bye|tama na)[.!]?$", caseSensitive: false);

  Future<void> _commit() async {
    if (!_recognizing) return;
    _recognizing = false;
    _endTimer?.cancel();
    _legacyTimer?.cancel();
    _turn?.mark('final');
    unawaited(engine.cancelListen());
    final words = (_overReply ? _freshWords() : _words).trim();
    if (words.isEmpty) {
      if (!_confirmed) return _falseAlarm();
      _set(_reply != null ? (speaking ? LiveVoiceState.speaking : LiveVoiceState.thinking) : LiveVoiceState.listening);
      return;
    }
    if (!_confirmed) await _confirm();
    // The interrupted reply must be cancelled before the next turn is sent (step 5 before step 8).
    final c = _cancelling;
    if (c != null) await c;
    _cancelling = null;
    if (_stop.hasMatch(words)) {
      onEnd?.call();
      return;
    }
    _turn?.mark('sent');
    _lastTurn = _turn;
    _set(LiveVoiceState.thinking);
    await onUtterance(words, {
      'mode': 'live',
      'lang': ?locale,
      'confidence': ?_conf,
      if (_alts.isNotEmpty) 'alternates': _alts,
    });
  }

  // ---- barge-in -------------------------------------------------------------------------------------
  Future<void> _tentativeBarge() async {
    _barge = VoiceTimeline('barge')..mark('detect');
    _held = true;
    _playing = false;
    // Stop the voice first (step 3–4), then open the recogniser with the speech so far (step 7).
    final flushing = engine.flush();
    final listening = _userStarted(barge: true);
    final f = await flushing;
    _barge?.mark('stopped');
    _queuedNative = 0;
    _resumeFrom = f.seq >= 0 ? f.seq : (_chunks.where((c) => !c.started).firstOrNull?.seq ?? -1);
    _heard = _heardText(f.seq, f.heardMs);
    await listening;
  }

  /// Stops the voice (audio focus lost, or a confirmed interruption) without resuming.
  Future<void> _flushVoice() async {
    _held = true;
    _playing = false;
    final f = await engine.flush();
    _queuedNative = 0;
    _heard = _heardText(f.seq, f.heardMs);
    _quietUntil = _t + tailMs;
  }

  String _heardText(int seq, int heardMs) {
    final out = <String>[];
    for (final c in _chunks) {
      if (seq >= 0 && c.seq > seq) break;
      if (!c.started) continue;
      if (c.seq == seq) {
        final dur = c.audio?.durationMs ?? 0;
        final w = wordsOf(c.text);
        final n = dur <= 0 ? 0 : (w.length * heardMs / dur).floor().clamp(0, w.length);
        if (n > 0) out.add(w.take(n).join(' '));
      } else {
        out.add(c.text);
      }
    }
    return out.join(' ').trim();
  }

  Future<void> _confirm() async {
    if (_confirmed) return;
    _confirmed = true;
    _barge?.mark('confirmed');
    if (!_overReply) return;
    // A real interruption: drop the reply here and cancel it on the server.
    if (!_held) await _flushVoice();
    final heard = _heard;
    _reply = null;
    _chunks.clear();
    _chunker.reset();
    _held = false;
    _quietUntil = 0;
    if (_recognizing && !_ending) _set(LiveVoiceState.userSpeaking);
    final cancel = _cancelling = onBargeIn(heard).catchError((_) {});
    await cancel;
    _barge?.mark('cancelled');
  }

  Future<void>? _cancelling;

  Future<void> _falseAlarm() async {
    _recognizing = false;
    _confirmed = true;
    _legacyTimer?.cancel();
    _endTimer?.cancel();
    unawaited(engine.cancelListen());
    final b = _barge;
    if (b != null) {
      b.falseAlarm = true;
      onTimeline?.call(b);
      _barge = null;
    }
    _held = false;
    // Resume from the chunk that was cut off (it restarts from its beginning).
    if (_resumeFrom >= 0) {
      for (final c in _chunks) {
        if (c.seq >= _resumeFrom && c.audio != null) {
          c.queued = true;
          _queuedNative++;
          await engine.play(c.seq, c.audio!.pcm, c.audio!.rate);
        }
      }
    }
    _resumeFrom = -1;
    _set(_reply != null ? (speaking ? LiveVoiceState.speaking : LiveVoiceState.thinking) : LiveVoiceState.listening);
    _maybeFinished();
  }

  // ---- replies --------------------------------------------------------------------------------------
  /// A new reply started streaming for the turn just sent.
  void beginReply(String id) {
    _reply = id;
    _chunker.reset();
    _chunks.clear();
    _replyClosed = false;
    _replyDone = false;
    _held = false;
    _gapAt = -1;
    if (!_recognizing) _set(LiveVoiceState.thinking);
  }

  /// A spoken piece of the reply arrived (token events with `say: true`).
  void say(String id, String delta) {
    if (id != _reply || _replyClosed) return;
    _lastTurn?.mark('firstSay');
    for (final c in _chunker.add(delta)) {
      _queueChunk(c);
    }
  }

  /// The spoken part ended (a tool started, or the on-screen details began): speak what is left.
  void closeSpeech(String id) {
    if (id != _reply) return;
    for (final c in _chunker.finish()) {
      _queueChunk(c);
    }
    // More speech can follow after a tool (the reply continues), so only [replyDone] closes the reply.
    _maybeFinished();
  }

  /// The reply finished on the server.
  void replyDone(String id, {Map<String, dynamic>? timing}) {
    if (id != _reply) return;
    closeSpeech(id);
    _replyClosed = true;
    _replyDone = true;
    if (timing != null) _lastTurn?.server = timing;
    _maybeFinished();
  }

  /// Says a fixed line (an approval prompt, an error) as its own reply.
  void sayLine(String text) {
    final id = 'line-${_seq + 1}';
    beginReply(id);
    say(id, '$text ');
    replyDone(id);
  }

  void _queueChunk(String text) {
    final s = normalizeForSpeech(text);
    if (s.isEmpty) return;
    _chunks.add(_Chunk(_seq++, _reply!, text, s));
    unawaited(_pump());
  }

  Future<void> _pump() async {
    if (_synthRunning) return;
    _synthRunning = true;
    try {
      while (true) {
        final c = _chunks.where((c) => c.audio == null && !c.failed).firstOrNull;
        if (c == null) break;
        _lastTurn?.mark('synthStart');
        try {
          c.audio = await synth.synth(c.say, voice: voice, speed: speed);
        } catch (e) {
          c.failed = true;
          onNotice?.call('The voice could not say part of the reply.');
          continue;
        }
        if (c.reply != _reply) continue; // stale: the reply was interrupted or replaced
        _lastTurn?.mark('synthDone');
        if (!_held) {
          c.queued = true;
          _queuedNative++;
          await engine.play(c.seq, c.audio!.pcm, c.audio!.rate);
        }
      }
    } finally {
      _synthRunning = false;
    }
    _maybeFinished();
  }

  void _onStarted(int seq) {
    final c = _chunks.where((c) => c.seq == seq).firstOrNull;
    if (c == null) return; // a stale chunk from before an interruption
    c.started = true;
    _playing = true;
    if (_gapAt >= 0) {
      _lastTurn?.gaps++;
      _lastTurn?.gapMs += _t - _gapAt;
      _gapAt = -1;
    }
    _lastTurn?.mark('audio');
    _barge?.mark('nextAudio');
    if (_barge?.marks['nextAudio'] != null) {
      onTimeline?.call(_barge!);
      _barge = null;
    }
    if (!_recognizing) _set(LiveVoiceState.speaking);
  }

  void _onDrained() {
    _playing = false;
    _queuedNative = 0;
    _quietUntil = _t + tailMs;
    final pending = _chunks.any((c) => !c.queued && !c.failed);
    if (_reply != null && (pending || !_replyClosed)) _gapAt = _t; // ran dry while more is coming
    _maybeFinished();
  }

  void _maybeFinished() {
    if (_reply == null || _held || _recognizing) return;
    final pending = _chunks.any((c) => !c.queued && !c.failed) || _synthRunning;
    if (pending || speaking) return;
    if (!_replyDone) {
      _set(LiveVoiceState.thinking);
      return;
    }
    _reply = null;
    final t = _lastTurn;
    if (t != null) {
      _gapAt = -1;
      onTimeline?.call(t);
      _lastTurn = null;
    }
    _set(LiveVoiceState.listening);
  }

  /// The run's stream dropped and is reconnecting.
  void reconnecting(bool on) {
    if (on && !_recognizing) _set(LiveVoiceState.reconnecting);
    if (!on && state == LiveVoiceState.reconnecting) _set(_reply != null ? LiveVoiceState.thinking : LiveVoiceState.listening);
  }

  /// The current reply was stopped from the screen (Stop button or a tap): drop its voice and
  /// return what the user heard of it, for the server's record of the interrupted reply.
  Future<String> interruptNow() async {
    await _flushVoice();
    final heard = _heard;
    _reply = null;
    _chunks.clear();
    _chunker.reset();
    _held = false;
    if (!_recognizing) _set(LiveVoiceState.listening);
    return heard;
  }

  Future<void> dropReply() => interruptNow();
}

/// Whether the recogniser accepts the conversation's own microphone audio on this phone. Turned off
/// for the rest of the process the first time it falls back to the system microphone.
bool liveInjectWorks = true;

/// The latest live-conversation timings, newest first (shown in Settings → Voice).
final liveTimings = LiveTimings._();

class LiveTimings {
  LiveTimings._();
  final List<VoiceTimeline> items = [];
  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;
  void add(VoiceTimeline t) {
    items.insert(0, t);
    if (items.length > 12) items.removeLast();
    _changes.add(null);
  }
}
