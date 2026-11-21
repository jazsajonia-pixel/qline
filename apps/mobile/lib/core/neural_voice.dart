import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:archive/archive_io.dart' show extractFileToDisk;
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

/// v1.12 (docs/30): Qline's own on-device voice. A neural text-to-speech model runs inside the app
/// through sherpa-onnx (Apache-2.0). Models are downloaded once from the sherpa-onnx GitHub releases,
/// checked against a fixed SHA-256, kept in the app's private storage and work offline afterwards.
/// No paid service, no Gemini quota and no other app is needed.
class VoiceModel {
  const VoiceModel({
    required this.id,
    required this.name,
    required this.summary,
    required this.url,
    required this.bytes,
    required this.sha256,
    required this.folder,
    required this.version,
    required this.license,
    required this.licenseUrl,
    this.voices = const [],
    this.defaultVoice = 0,
  });
  final String id, name, summary, url, sha256, folder, version, license, licenseUrl;
  final int bytes, defaultVoice;
  final List<String> voices;
}

/// Measured in the sandbox (docs/30 §4). Phone numbers come from "Benchmark this phone" in Settings.
const voiceCatalog = <VoiceModel>[
  VoiceModel(
    id: 'supertonic-3',
    name: 'Supertonic 3',
    summary: 'Most natural. 10 voices, clear names and numbers.',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2',
    bytes: 128774318,
    sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
    folder: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    version: '2026-05-11',
    license: 'Model: OpenRAIL-M (use restrictions apply). Runtime: Apache-2.0.',
    licenseUrl: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE',
    voices: _supertonicVoices,
    defaultVoice: 5,
  ),
  VoiceModel(
    id: 'supertonic-2',
    name: 'Supertonic 2 (faster)',
    summary: 'About twice as fast and smaller. Slightly less natural.',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-tts-int8-2026-03-06.tar.bz2',
    bytes: 84692981,
    sha256: '8c74359f63edd5045d47747f65331f0f6dbcbc91d7e898dd756d631295fe3259',
    folder: 'sherpa-onnx-supertonic-tts-int8-2026-03-06',
    version: '2026-03-06',
    license: 'Model: OpenRAIL-M (use restrictions apply). Runtime: Apache-2.0.',
    licenseUrl: 'https://huggingface.co/Supertone/supertonic-2/blob/main/LICENSE',
    voices: _supertonicVoices,
    defaultVoice: 5,
  ),
];

const _supertonicVoices = ['Voice 1 (female)', 'Voice 2 (female)', 'Voice 3 (female)', 'Voice 4 (female)', 'Voice 5 (female)', 'Voice 6 (male)', 'Voice 7 (male)', 'Voice 8 (male)', 'Voice 9 (male)', 'Voice 10 (male)'];

VoiceModel? voiceModelById(String? id) => voiceCatalog.where((m) => m.id == id).firstOrNull;

/// Downloads, checks, unpacks and deletes voice models in the app's private storage.
class VoiceStore {
  // ignore: prefer_initializing_formals
  VoiceStore({Future<Directory> Function()? root, http.Client? client}) : _root = root ?? getApplicationSupportDirectory, _client = client;
  final Future<Directory> Function() _root;
  final http.Client? _client;

  Future<Directory> _dir(VoiceModel m) async => Directory('${(await _root()).path}/voices/${m.id}');

  /// Where the model files are once installed, or null.
  Future<String?> installedPath(VoiceModel m) async {
    final d = Directory('${(await _dir(m)).path}/${m.folder}');
    final ok = File('${d.path}/.qline-ok');
    return await ok.exists() ? d.path : null;
  }

  Future<int> sizeOnDisk(VoiceModel m) async {
    final d = await _dir(m);
    if (!await d.exists()) return 0;
    var n = 0;
    await for (final f in d.list(recursive: true)) {
      if (f is File) n += await f.length();
    }
    return n;
  }

  Future<void> delete(VoiceModel m) async {
    final d = await _dir(m);
    if (await d.exists()) await d.delete(recursive: true);
  }

  /// Downloads [m] with progress (0..1), checks its SHA-256 and unpacks it. Throws on any mismatch.
  Future<String> install(VoiceModel m, {void Function(double progress, String stage)? onProgress, bool Function()? cancelled}) async {
    final d = await _dir(m);
    await d.create(recursive: true);
    final part = File('${d.path}/download.part');
    final client = _client ?? http.Client();
    try {
      final res = await client.send(http.Request('GET', Uri.parse(m.url)));
      if (res.statusCode != 200) throw VoiceStoreException('The download failed (HTTP ${res.statusCode}).');
      final sink = part.openWrite();
      final digest = _DigestSink();
      final hasher = sha256.startChunkedConversion(digest);
      var got = 0;
      try {
        await for (final chunk in res.stream) {
          if (cancelled?.call() == true) throw VoiceStoreException('Download cancelled.');
          sink.add(chunk);
          hasher.add(chunk);
          got += chunk.length;
          onProgress?.call(got / m.bytes, 'download');
        }
      } finally {
        await sink.close();
      }
      hasher.close();
      if (got != m.bytes || digest.value.toString() != m.sha256) {
        throw VoiceStoreException('The downloaded voice did not match its checksum, so it was not installed.');
      }
      onProgress?.call(1, 'unpack');
      final tar = '${d.path}/model.tar.bz2';
      await part.rename(tar);
      await Isolate.run(() => extractFileToDisk(tar, d.path, verify: true, maxSize: 600 * 1024 * 1024));
      await File(tar).delete();
      final dir = '${d.path}/${m.folder}';
      for (final f in ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin']) {
        if (!await File('$dir/$f').exists()) throw VoiceStoreException('The voice package is missing $f.');
      }
      await File('$dir/.qline-ok').writeAsString(m.version);
      return dir;
    } catch (_) {
      if (await part.exists()) await part.delete();
      rethrow;
    } finally {
      if (_client == null) client.close();
    }
  }
}

class VoiceStoreException implements Exception {
  VoiceStoreException(this.message);
  final String message;
  @override
  String toString() => message;
}

class _DigestSink implements Sink<Digest> {
  late Digest value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}

/// One synthesised chunk: 16-bit PCM, its rate and how long synthesis took.
class SynthAudio {
  SynthAudio(this.pcm, this.rate, this.ms);
  final Uint8List pcm;
  final int rate, ms;
  int get durationMs => rate == 0 ? 0 : pcm.length ~/ 2 * 1000 ~/ rate;
}

/// Turns text into audio. [NeuralVoice] is the real one; tests use a fake.
abstract class Synthesizer {
  Future<SynthAudio> synth(String text, {int? voice, double? speed});
}

/// The model loaded once in a background isolate, so the UI and the microphone never wait on it.
/// Requests run one at a time in order; the caller decides what is still worth playing.
class NeuralVoice implements Synthesizer {
  NeuralVoice._(this._send, this._iso, this.sampleRate, this.voices, this.loadMs);
  final SendPort _send;
  final Isolate _iso;
  final int sampleRate, voices, loadMs;
  int voice = 5;
  double speed = 1.0;
  int _next = 0;
  final _pending = <int, Completer<SynthAudio>>{};
  late final ReceivePort _rx;

  static Future<NeuralVoice> load(String dir, {int threads = 2}) async {
    final rx = ReceivePort();
    final iso = await Isolate.spawn(_main, [rx.sendPort, dir, threads], debugName: 'qline-voice');
    final it = StreamIterator(rx);
    if (!await it.moveNext()) throw StateError('voice did not start');
    final hello = it.current as List;
    if (hello[0] == 'error') {
      iso.kill();
      throw VoiceStoreException('The voice could not load: ${hello[1]}');
    }
    final v = NeuralVoice._(hello[1] as SendPort, iso, hello[2] as int, hello[3] as int, hello[4] as int);
    v._rx = rx;
    () async {
      while (await it.moveNext()) {
        final m = it.current as List;
        final c = v._pending.remove(m[0] as int);
        if (c == null) continue;
        if (m[1] == 'error') {
          c.completeError(VoiceStoreException(m[2] as String));
        } else {
          c.complete(SynthAudio((m[2] as TransferableTypedData).materialize().asUint8List(), m[3] as int, m[4] as int));
        }
      }
    }();
    return v;
  }

  @override
  Future<SynthAudio> synth(String text, {int? voice, double? speed}) {
    final id = _next++;
    final c = Completer<SynthAudio>();
    _pending[id] = c;
    _send.send([id, text, voice ?? this.voice, speed ?? this.speed]);
    return c.future;
  }

  void dispose() {
    _iso.kill(priority: Isolate.immediate);
    _rx.close();
    for (final c in _pending.values) {
      c.completeError(VoiceStoreException('The voice was closed.'));
    }
    _pending.clear();
  }

  static void _main(List args) {
    final out = args[0] as SendPort;
    final dir = args[1] as String;
    final threads = args[2] as int;
    sherpa.OfflineTts tts;
    final t0 = DateTime.now();
    try {
      sherpa.initBindings();
      tts = sherpa.OfflineTts(sherpa.OfflineTtsConfig(
        model: sherpa.OfflineTtsModelConfig(
          supertonic: sherpa.OfflineTtsSupertonicModelConfig(
            durationPredictor: '$dir/duration_predictor.int8.onnx',
            textEncoder: '$dir/text_encoder.int8.onnx',
            vectorEstimator: '$dir/vector_estimator.int8.onnx',
            vocoder: '$dir/vocoder.int8.onnx',
            ttsJson: '$dir/tts.json',
            unicodeIndexer: '$dir/unicode_indexer.bin',
            voiceStyle: '$dir/voice.bin',
          ),
          numThreads: threads,
        ),
      ));
      // Warm up so the first real sentence is not the slow one.
      tts.generateWithConfig(text: 'Hi.', config: const sherpa.OfflineTtsGenerationConfig(extra: {'lang': 'en'}));
    } catch (e) {
      out.send(['error', '$e']);
      return;
    }
    final rx = ReceivePort();
    out.send(['ready', rx.sendPort, tts.sampleRate, tts.numSpeakers, DateTime.now().difference(t0).inMilliseconds]);
    rx.listen((m) {
      final r = m as List;
      final id = r[0] as int;
      try {
        final t = DateTime.now();
        final a = tts.generateWithConfig(text: r[1] as String, config: sherpa.OfflineTtsGenerationConfig(sid: r[2] as int, speed: (r[3] as num).toDouble(), extra: const {'lang': 'en'}));
        final pcm = ByteData(a.samples.length * 2);
        for (var i = 0; i < a.samples.length; i++) {
          pcm.setInt16(i * 2, (a.samples[i].clamp(-1.0, 1.0) * 32767).round(), Endian.little);
        }
        out.send([id, 'ok', TransferableTypedData.fromList([pcm.buffer.asUint8List()]), a.sampleRate, DateTime.now().difference(t).inMilliseconds]);
      } catch (e) {
        out.send([id, 'error', '$e']);
      }
    });
  }
}

/// The loaded on-device voice, shared by Live and spoken replies (one model in memory at a time).
class QlineVoiceHub {
  QlineVoiceHub._();
  static final instance = QlineVoiceHub._();
  final store = VoiceStore();
  NeuralVoice? _voice;
  String? _id;
  Future<NeuralVoice?>? _loading;

  NeuralVoice? get loaded => _voice;

  /// Loads [modelId] (or the default) if it is installed; null when it is not downloaded yet.
  Future<NeuralVoice?> load(String? modelId, {int? voice, double speed = 1}) async {
    final m = voiceModelById(modelId) ?? voiceCatalog.first;
    if (_id != m.id || _voice == null) {
      _loading ??= () async {
        final path = await store.installedPath(m);
        if (path == null) return null;
        _voice?.dispose();
        _voice = null;
        final v = await NeuralVoice.load(path);
        _voice = v;
        _id = m.id;
        return v;
      }();
      try {
        await _loading;
      } finally {
        _loading = null;
      }
    }
    final v = _voice;
    if (v == null || _id != m.id) return null;
    v.voice = (voice ?? m.defaultVoice).clamp(0, math.max(0, v.voices - 1));
    v.speed = speed;
    return v;
  }

  void unload() {
    _voice?.dispose();
    _voice = null;
    _id = null;
  }
}

/// Settings speed slider (0.3–0.8, 0.5 = normal) → model speed.
double neuralSpeed(double rate) => (0.6 + rate * 0.8).clamp(0.75, 1.3);
