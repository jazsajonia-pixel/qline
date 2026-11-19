import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_tts/flutter_tts.dart';

import 'api.dart';

/// Voice settings (stored on the device).
class VoicePrefs {
  const VoicePrefs({this.engine = 'device', this.voice, this.deviceVoice, this.rate = .5});
  final String engine; // device | gemini | openai
  final String? voice; // provider voice id
  final Map<String, String>? deviceVoice; // {name, locale}
  final double rate;
  VoicePrefs copy({String? engine, String? voice, Map<String, String>? deviceVoice, double? rate, bool clearVoice = false}) =>
      VoicePrefs(engine: engine ?? this.engine, voice: clearVoice ? null : (voice ?? this.voice), deviceVoice: deviceVoice ?? this.deviceVoice, rate: rate ?? this.rate);
  Map<String, dynamic> toJson() => {'engine': engine, 'voice': voice, 'deviceVoice': deviceVoice, 'rate': rate};
  static VoicePrefs fromJson(Map<String, dynamic> j) => VoicePrefs(
        engine: j['engine'] as String? ?? 'device',
        voice: j['voice'] as String?,
        deviceVoice: (j['deviceVoice'] as Map?)?.map((k, v) => MapEntry('$k', '$v')),
        rate: (j['rate'] as num?)?.toDouble() ?? .5,
      );
}

final voicePrefsProvider = NotifierProvider<VoicePrefsNotifier, VoicePrefs>(VoicePrefsNotifier.new);

class VoicePrefsNotifier extends Notifier<VoicePrefs> {
  static const _storage = FlutterSecureStorage();
  @override
  VoicePrefs build() {
    Future.microtask(() async {
      try {
        final v = await _storage.read(key: 'voice');
        if (v != null) state = VoicePrefs.fromJson((jsonDecode(v) as Map).cast<String, dynamic>());
      } catch (_) {}
    });
    return const VoicePrefs();
  }

  void set(VoicePrefs p) {
    state = p;
    _storage.write(key: 'voice', value: jsonEncode(p.toJson()));
  }
}

/// Removes markdown and symbols that sound bad when read aloud.
String speakable(String s) => s
    .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
    .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1]!)
    .replaceAll(RegExp(r'[*_`#>|~]+'), '')
    .replaceAll(RegExp(r'https?://\S+'), 'a link')
    .replaceAll(RegExp(r'^\s*[-•]\s+', multiLine: true), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

List<String> wordsOf(String s) => s.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();

/// Decides when a spoken request is finished and sends it exactly once.
///
/// Many Android speech services never deliver a `finalResult`, or report `done` / `notListening`
/// before it arrives. So a request is committed on whichever comes first: the final result, the
/// recogniser stopping, or [silence] with no new words.
/// v1.6: what to say for a reply — the model's short spoken line, or the first sentence or two of
/// the written answer when there is none. The voice never reads a long answer word for word.
String spokenLine(String? speech, String text, {int maxChars = 220}) {
  final sp = speakable(speech ?? '');
  if (sp.isNotEmpty) return sp;
  final t = speakable(text);
  final sentences = RegExp(r'[^.!?]+[.!?]+(\s|$)|[^.!?]+$').allMatches(t).map((m) => m.group(0)!).toList();
  var out = '';
  var n = 0;
  for (final s in sentences) {
    if ((out + s).length > maxChars && out.isNotEmpty) break;
    out += s;
    n++;
    if (n >= 2 || out.length > 80) break;
  }
  out = out.trim();
  if (out.length > maxChars) out = '${out.substring(0, maxChars - 1).replaceFirst(RegExp(r'\s+\S*$'), '')}…';
  return out;
}

/// Words that usually mean the speaker has more to say.
const _trailing = {
  'and', 'but', 'or', 'so', 'because', 'cause', 'the', 'a', 'an', 'to', 'of', 'with', 'for', 'if', 'then', 'um', 'uh', 'erm',
  'like', 'my', 'your', 'about', 'in', 'on', 'at', 'is', 'are', 'was', 'that', 'which', 'also', 'plus', 'maybe', 'i',
};

/// How long to wait for more speech after [words] before sending (M6 adaptive end-of-turn).
/// Waits longer after a dangling word ("…and", "um") or a short fragment, and less after a long,
/// complete-sounding request. Clamped to 800–2600 ms.
Duration waitFor(String words, Duration base) {
  final w = words.trim().toLowerCase();
  final list = w.split(RegExp(r'\s+')).where((x) => x.isNotEmpty).toList();
  var ms = base.inMilliseconds;
  if (list.isEmpty) return base;
  final last = list.last.replaceAll(RegExp(r"[^a-z']"), '');
  if (w.endsWith(',') || w.endsWith('...') || _trailing.contains(last)) {
    ms += 900;
  } else if (RegExp(r'[.?!]$').hasMatch(w)) {
    ms -= 400;
  } else if (list.length <= 2) {
    ms += 400;
  } else if (list.length >= 8) {
    ms -= 250;
  }
  return Duration(milliseconds: ms.clamp(800, 2600));
}

class UtteranceGate {
  UtteranceGate({required this.onCommit, this.silence = const Duration(milliseconds: 1500)});
  final void Function(String words) onCommit;
  Duration silence;
  String _heard = '';
  bool _committed = false;
  Timer? _timer;

  String get heard => _heard;
  bool get committed => _committed;

  /// Starts a new utterance.
  void reset() {
    _timer?.cancel();
    _heard = '';
    _committed = false;
  }

  /// A recognition result (partial or final).
  void feed(String words, {bool isFinal = false}) {
    if (_committed) return;
    final w = words.trim();
    if (w.isEmpty) return;
    final changed = w != _heard;
    _heard = w;
    if (isFinal) return commit();
    if (changed) {
      _timer?.cancel();
      _timer = Timer(waitFor(w, silence), commit);
    }
  }

  /// The recogniser stopped (done / notListening / user tapped the mic).
  void ended() => commit();

  void commit() {
    _timer?.cancel();
    if (_committed || _heard.isEmpty) return;
    _committed = true;
    onCommit(_heard);
  }

  void dispose() => _timer?.cancel();
}

/// Rough syllable count, used to size the core's pulse for each spoken word.
int syllables(String word) {
  final w = word.toLowerCase().replaceAll(RegExp(r'[^a-z]'), '');
  if (w.isEmpty) return 1;
  final groups = RegExp(r'[aeiouy]+').allMatches(w).length - (w.length > 3 && w.endsWith('e') && !w.endsWith('le') ? 1 : 0);
  return groups.clamp(1, 6);
}

/// Estimated word boundaries (ms from start) for [words] at TTS [rate] (0..1, 0.5 = normal).
List<double> estimateWordTimes(List<String> words, double rate) {
  final msPerSyllable = 210 / (rate <= 0 ? .5 : rate) * .5; // ~ 4.8 syllables/s at normal rate
  final out = <double>[];
  var acc = 0.0;
  for (final w in words) {
    acc += syllables(w) * msPerSyllable + (RegExp(r'[,;:]$').hasMatch(w) ? 180 : 0) + (RegExp(r'[.!?]$').hasMatch(w) ? 380 : 0) + 40;
    out.add(acc);
  }
  return out;
}

/// Splits long replies so the first audio arrives quickly: a short opener, then up to ~1200 chars per part.
List<String> chunk(String text) {
  final sentences = RegExp(r'[^.!?]+[.!?]+["”)]*\s*|[^.!?]+$').allMatches(text).map((m) => m[0]!.trim()).where((s) => s.isNotEmpty).toList();
  final out = <String>[];
  var cur = '';
  for (final s in sentences) {
    final limit = out.isEmpty ? 220 : 1200;
    if (cur.isNotEmpty && cur.length + s.length + 1 > limit) {
      out.add(cur);
      cur = s;
    } else {
      cur = cur.isEmpty ? s : '$cur $s';
    }
  }
  if (cur.isNotEmpty) out.add(cur);
  return out.take(4).toList();
}

/// Plays a reply aloud and reports the spoken word index and a 0..1 loudness level as it goes,
/// so the energy core pulses with each word as it is spoken.
class Speaker {
  Speaker({required this.onWord, required this.onLevel, required this.onDone, required this.onNotice});
  final void Function(int index) onWord;
  final void Function(double level) onLevel;
  final void Function() onDone;
  final void Function(String message) onNotice;

  final FlutterTts _tts = FlutterTts();
  // Created on first playback, so stopping before anything played never touches the native player.
  AudioPlayer? _playerOrNull;
  AudioPlayer get _player => _playerOrNull ??= AudioPlayer();
  Timer? _tick;
  int _session = 0;
  bool _ttsReady = false;
  bool get speaking => _speaking;
  bool _speaking = false;
  double _level = 0;

  Future<void> _initTts(VoicePrefs p) async {
    if (!_ttsReady) {
      _ttsReady = true;
      await _tts.awaitSpeakCompletion(true);
      try {
        await _tts.setAudioAttributesForNavigation();
      } catch (_) {}
    }
    await _tts.setSpeechRate(p.rate);
    await _tts.setPitch(1.0);
    final dv = p.deviceVoice ?? await bestDeviceVoice();
    if (dv != null) {
      try {
        await _tts.setVoice(dv);
      } catch (_) {}
    }
  }

  /// Voices on this phone, most natural first (network / high quality voices first).
  Future<List<Map<String, String>>> deviceVoices() async {
    try {
      final raw = await _tts.getVoices as List? ?? const [];
      final list = raw.map((v) => (v as Map).map((k, x) => MapEntry('$k', '$x'))).toList();
      int score(Map<String, String> v) {
        final n = (v['name'] ?? '').toLowerCase();
        final q = (v['quality'] ?? '').toLowerCase();
        var s = 0;
        if ((v['locale'] ?? '').toLowerCase().startsWith('en')) s += 100;
        if (n.contains('network')) s += 40;
        if (q.contains('very_high') || q == '500') s += 30;
        if (q.contains('high') || q == '400') s += 20;
        if (n.contains('local')) s += 5;
        return s;
      }

      list.sort((a, b) => score(b).compareTo(score(a)));
      return list.map((v) => {'name': v['name'] ?? '', 'locale': v['locale'] ?? ''}).where((v) => v['name']!.isNotEmpty).toList();
    } catch (_) {
      return const [];
    }
  }

  Future<Map<String, String>?> bestDeviceVoice() async => (await deviceVoices()).firstOrNull;

  Future<void> stop() async {
    _session++;
    _tick?.cancel();
    _speaking = false;
    _level = 0;
    onLevel(0);
    try {
      await _playerOrNull?.stop();
    } catch (_) {}
    try {
      await _tts.stop();
    } catch (_) {}
  }

  Future<void> dispose() async {
    await stop();
    await _playerOrNull?.dispose();
  }

  /// Speaks [text]. Word indexes refer to wordsOf(speakable(text)).
  Future<void> speak(Api api, String text, VoicePrefs p) async {
    await stop();
    final my = ++_session;
    final clean = speakable(text);
    if (clean.isEmpty) return onDone();
    _speaking = true;
    final parts = chunk(clean);
    var offset = 0;
    var engine = p.engine;
    Future<Map<String, dynamic>?>? next;
    Future<Map<String, dynamic>?> fetch(String part) async {
      try {
        return ((await api.post('/voice/speak', {'text': part, 'engine': engine, if (p.voice != null) 'voice': p.voice})) as Map).cast<String, dynamic>();
      } on ApiException catch (e) {
        if (engine != 'device') onNotice('${e.title}. Using the phone voice.');
        engine = 'device';
        return null;
      }
    }

    if (engine != 'device') next = fetch(parts.first);
    for (var i = 0; i < parts.length; i++) {
      if (my != _session) return;
      final part = parts[i];
      final audio = engine == 'device' ? null : await next;
      if (my != _session) return;
      if (engine != 'device' && i + 1 < parts.length) next = fetch(parts[i + 1]);
      if (audio != null) {
        await _playAudio(audio, part, offset, my);
      } else {
        await _speakDevice(part, offset, p, my);
      }
      offset += wordsOf(part).length;
    }
    if (my != _session) return;
    _speaking = false;
    _tick?.cancel();
    onLevel(0);
    onDone();
  }

  Future<void> _speakDevice(String part, int offset, VoicePrefs p, int my) async {
    await _initTts(p);
    // Character offset → word index for the engine's progress callbacks.
    final starts = <int>[];
    for (final m in RegExp(r'\S+').allMatches(part)) {
      starts.add(m.start);
    }
    final words = wordsOf(part);
    var gotProgress = false;
    var lastWord = -1;
    void hit(int idx) {
      if (idx == lastWord) return;
      lastWord = idx;
      onWord(offset + idx);
      _level = .55 + .45 * math.min(1, syllables(words[idx.clamp(0, words.length - 1)]) / 3); // a pulse per spoken word
    }

    _tts.setProgressHandler((String t, int start, int end, String word) {
      if (my != _session) return;
      gotProgress = true;
      var idx = 0;
      while (idx + 1 < starts.length && starts[idx + 1] <= start) {
        idx++;
      }
      hit(idx);
    });
    // Some engines never send progress callbacks: fall back to estimated word timing,
    // timed from the moment the engine reports it started speaking (not from when we asked it to).
    final est = estimateWordTimes(words, p.rate);
    final clock = Stopwatch();
    var started = false;
    _tts.setStartHandler(() {
      if (my != _session || started) return;
      started = true;
      clock
        ..reset()
        ..start();
    });
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(milliseconds: 33), (_) {
      if (my != _session) return;
      // No start callback after 600 ms: assume it started (older engines).
      if (!started && clock.elapsedMilliseconds > 600) {
        started = true;
        clock
          ..reset()
          ..start();
      }
      if (!gotProgress && started && words.isNotEmpty) {
        final t = clock.elapsedMilliseconds;
        var w = est.indexWhere((b) => b > t);
        if (w < 0) w = words.length - 1;
        hit(w);
      }
      _level *= .86;
      onLevel(_level);
    });
    clock.start();
    await _tts.speak(part);
    clock.stop();
    _level = 0;
    onLevel(0);
  }

  Future<void> _playAudio(Map<String, dynamic> a, String part, int offset, int my) async {
    final bytes = base64Decode(a['audio'] as String);
    final env = ((a['envelope'] as List?) ?? const []).map((e) => (e as num).toDouble()).toList();
    final stepMs = (a['envelopeMs'] as num?)?.toInt() ?? 50;
    final durMs = (a['durationMs'] as num?)?.toInt() ?? (env.length * stepMs);
    // Word timing: spread the voiced span across words, weighted by length and punctuation pauses.
    final words = wordsOf(part);
    var first = env.indexWhere((v) => v > .08);
    var last = env.lastIndexWhere((v) => v > .08);
    if (first < 0) first = 0;
    if (last < 0) last = env.length - 1;
    final startMs = first * stepMs, endMs = math.max(startMs + 1, (last + 1) * stepMs);
    final weights = words.map((w) => w.length + 2 + (RegExp(r'[,;:]$').hasMatch(w) ? 3 : 0) + (RegExp(r'[.!?]$').hasMatch(w) ? 6 : 0)).toList();
    final total = weights.fold<int>(0, (s, w) => s + w);
    final bounds = <double>[];
    var acc = 0;
    for (final w in weights) {
      acc += w;
      bounds.add(startMs + (endMs - startMs) * acc / math.max(1, total));
    }
    final done = Completer<void>();
    late StreamSubscription<void> sub;
    sub = _player.onPlayerComplete.listen((_) {
      if (!done.isCompleted) done.complete();
    });
    // Follow the player's own position (re-anchored on every position update) so the core moves
    // with the sound, not with when play() returned. Nothing moves until audio is actually playing.
    final clock = Stopwatch();
    var basePos = -1;
    final posSub = _player.onPositionChanged.listen((d) {
      if (my != _session) return;
      basePos = d.inMilliseconds;
      clock
        ..reset()
        ..start();
    });
    final stateSub = _player.onPlayerStateChanged.listen((st) {
      if (st == PlayerState.playing && basePos < 0) {
        basePos = 0;
        clock
          ..reset()
          ..start();
      }
    });
    await _player.play(BytesSource(bytes, mimeType: 'audio/wav'));
    var lastWord = -1;
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(milliseconds: 33), (_) {
      if (my != _session) return;
      if (basePos < 0) {
        onLevel(0);
        return;
      }
      final t = basePos + clock.elapsedMilliseconds;
      final i = (t / stepMs).floor();
      onLevel(i < env.length ? env[i] : 0);
      var w = bounds.indexWhere((b) => b > t);
      if (w < 0) w = words.length - 1;
      if (t >= startMs && w != lastWord) {
        lastWord = w;
        onWord(offset + w);
      }
      if (t > durMs + 1500 && !done.isCompleted) done.complete(); // safety net
    });
    await done.future;
    await sub.cancel();
    await posSub.cancel();
    await stateSub.cancel();
    _tick?.cancel();
    onLevel(0);
  }
}
