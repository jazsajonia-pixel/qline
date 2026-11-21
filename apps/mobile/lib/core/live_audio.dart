import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/services.dart';

/// v1.12 (docs/30): the phone side of a live conversation, over the "qline/live_audio" channel
/// (android/.../LiveAudio.kt). [LiveAudioEngine] is the seam the conversation logic is tested through.
abstract class LiveAudioEngine {
  Stream<Map<String, dynamic>> get events;
  Future<Map<String, dynamic>> capabilities();

  /// Opens the echo-cancelled microphone and (with [service]) the "Qline is listening" notification.
  Future<Map<String, dynamic>> start({bool aec = true, bool service = true});
  Future<void> stop();

  /// Queues one chunk of 16-bit mono PCM; chunks play in the order they are queued, with no gap.
  Future<void> play(int seq, Uint8List pcm, int rate);

  /// Stops the voice at once and drops what is queued: which chunk was playing and how much was heard.
  Future<({int seq, int heardMs, bool wasPlaying})> flush();

  /// Starts the recogniser on the live microphone; [preRoll] is the speech before it was detected.
  Future<({bool ok, bool inject})> listen({String? locale, Uint8List? preRoll, bool inject = true});

  /// The user stopped talking: the recogniser finishes and sends its final words.
  Future<void> endListen();
  Future<void> cancelListen();
}

class PlatformLiveAudio implements LiveAudioEngine {
  PlatformLiveAudio._();

  /// One instance: Android delivers events to a single listener, shared here by everyone.
  static final instance = PlatformLiveAudio._();
  static const _m = MethodChannel('qline/live_audio');
  static const _e = EventChannel('qline/live_audio/events');
  static Stream<Map<String, dynamic>>? _events;

  @override
  Stream<Map<String, dynamic>> get events => _events ??= _e.receiveBroadcastStream().map((e) => Map<String, dynamic>.from(e as Map)).asBroadcastStream();

  Future<Map<String, dynamic>> _map(String m, [Map<String, dynamic>? a]) async => Map<String, dynamic>.from(await _m.invokeMethod<Map>(m, a) ?? const {});

  @override
  Future<Map<String, dynamic>> capabilities() async {
    try {
      return await _map('capabilities');
    } on MissingPluginException {
      return const {'supported': false};
    }
  }

  @override
  Future<Map<String, dynamic>> start({bool aec = true, bool service = true}) => _map('start', {'aec': aec, 'service': service});
  @override
  Future<void> stop() => _m.invokeMethod('stop');
  @override
  Future<void> play(int seq, Uint8List pcm, int rate) => _m.invokeMethod('play', {'seq': seq, 'pcm': pcm, 'rate': rate});
  @override
  Future<({int seq, int heardMs, bool wasPlaying})> flush() async {
    final r = await _map('flush');
    return (seq: (r['seq'] as num?)?.toInt() ?? -1, heardMs: (r['heardMs'] as num?)?.toInt() ?? 0, wasPlaying: r['wasPlaying'] == true);
  }

  @override
  Future<({bool ok, bool inject})> listen({String? locale, Uint8List? preRoll, bool inject = true}) async {
    final r = await _map('listen', {'locale': locale, 'preRoll': preRoll, 'inject': inject});
    return (ok: r['ok'] == true, inject: r['inject'] == true);
  }

  @override
  Future<void> endListen() => _m.invokeMethod('endListen');
  @override
  Future<void> cancelListen() => _m.invokeMethod('cancelListen');
}

/// Float samples (-1..1) → 16-bit little-endian PCM.
Uint8List floatToPcm16(Float32List s) {
  final out = ByteData(s.length * 2);
  for (var i = 0; i < s.length; i++) {
    final v = (s[i].clamp(-1.0, 1.0) * 32767).round();
    out.setInt16(i * 2, v, Endian.little);
  }
  return out.buffer.asUint8List();
}

/// 16-bit little-endian PCM → float samples.
Float32List pcm16ToFloat(Uint8List b) {
  final d = ByteData.sublistView(b);
  final out = Float32List(b.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = d.getInt16(i * 2, Endian.little) / 32768.0;
  }
  return out;
}

/// Root-mean-square level of a frame (0..1).
double rms(Float32List s) {
  if (s.isEmpty) return 0;
  var sum = 0.0;
  for (final v in s) {
    sum += v * v;
  }
  final r = sum / s.length;
  return r <= 0 ? 0 : math.sqrt(r);
}
