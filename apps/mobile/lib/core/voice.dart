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
/// so the energy core and the captions follow the actual speech.
class Speaker {
  Speaker({required this.onWord, required this.onLevel, required this.onDone, required this.onNotice});
  final void Function(int index) onWord;
  final void Function(double level) onLevel;
  final void Function() onDone;
  final void Function(String message) onNotice;

  final FlutterTts _tts = FlutterTts();
  final AudioPlayer _player = AudioPlayer();
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
      await _player.stop();
    } catch (_) {}
    try {
      await _tts.stop();
    } catch (_) {}
  }

  Future<void> dispose() async {
    await stop();
    await _player.dispose();
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
    _tts.setProgressHandler((String t, int start, int end, String word) {
      if (my != _session) return;
      var idx = 0;
      while (idx + 1 < starts.length && starts[idx + 1] <= start) {
        idx++;
      }
      onWord(offset + idx);
      _level = .55 + .45 * math.min(1, word.length / 7); // a pulse per spoken word
    });
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(milliseconds: 33), (_) {
      _level *= .86;
      onLevel(_level);
    });
    await _tts.speak(part);
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
    final clock = Stopwatch();
    await _player.play(BytesSource(bytes, mimeType: 'audio/wav'));
    clock.start();
    var lastWord = -1;
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(milliseconds: 33), (_) {
      if (my != _session) return;
      final t = clock.elapsedMilliseconds;
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
    _tick?.cancel();
  }
}
