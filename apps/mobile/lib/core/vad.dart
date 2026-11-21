import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import 'live_conversation.dart';

/// v1.12 (docs/30): Silero voice activity detection (MIT, bundled as assets/voice/silero_vad.onnx, 644 KB)
/// through sherpa-onnx. Two detectors share each frame: a normal one for the user's turns and a stricter
/// one (higher probability, longer minimum speech) used while Qline is talking, for barge-in.
class SileroDetector implements SpeechDetector {
  SileroDetector._(this._normal, this._strict);
  final sherpa.VoiceActivityDetector _normal, _strict;

  static bool _bound = false;

  static Future<SileroDetector> create() async {
    if (!_bound) {
      sherpa.initBindings();
      _bound = true;
    }
    final dir = await getApplicationSupportDirectory();
    final f = File('${dir.path}/voices/silero_vad.onnx');
    if (!await f.exists()) {
      await f.parent.create(recursive: true);
      final data = await rootBundle.load('assets/voice/silero_vad.onnx');
      await f.writeAsBytes(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes), flush: true);
    }
    sherpa.VoiceActivityDetector make(double threshold, double minSpeech, double minSilence) => sherpa.VoiceActivityDetector(
          config: sherpa.VadModelConfig(
            sileroVad: sherpa.SileroVadModelConfig(model: f.path, threshold: threshold, minSpeechDuration: minSpeech, minSilenceDuration: minSilence, windowSize: 512, maxSpeechDuration: 60),
            sampleRate: 16000,
            numThreads: 1,
            debug: false,
          ),
          bufferSizeInSeconds: 30,
        );
    return SileroDetector._(make(.5, .12, .2), make(.72, .2, .15));
  }

  @override
  VadResult accept(Float32List frame) {
    _normal.acceptWaveform(frame);
    _strict.acceptWaveform(frame);
    final r = VadResult(_normal.isDetected(), _strict.isDetected());
    // Only the live state is used; drop finished segments so memory stays flat.
    while (!_normal.isEmpty()) {
      _normal.pop();
    }
    while (!_strict.isEmpty()) {
      _strict.pop();
    }
    return r;
  }

  @override
  void reset() {
    _normal.clear();
    _strict.clear();
  }

  void dispose() {
    _normal.free();
    _strict.free();
  }
}
