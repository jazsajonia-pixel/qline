import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'alerts.dart';
import 'config.dart';

/// v1.11 (docs/28): in-app updates from the public GitHub releases.
///
/// Qline checks the latest release, tells the person a new version is ready (a banner and one notification per
/// version) and never forces it: "Later" hides it for three days. "Update" downloads the signed APK, checks its
/// SHA-256 against the release, and hands it to Android, which always asks the person to confirm. Android then
/// replaces the app and Qline reopens itself (or leaves a "tap to open" notification when Android blocks that).

const latestReleaseUrl = 'https://api.github.com/repos/jazsajonia-pixel/qline/releases/latest';
const releasesPage = 'https://github.com/jazsajonia-pixel/qline/releases/latest';
const updateMaxBytes = 200 * 1024 * 1024;
const snoozeFor = Duration(days: 3);
const autoCheckEvery = Duration(hours: 6);

class AppRelease {
  const AppRelease({required this.version, required this.apkUrl, required this.sha256, this.size, this.notes = '', this.pageUrl, this.publishedAt});
  final String version;
  final String apkUrl;
  final String sha256;
  final int? size;
  final String notes;
  final String? pageUrl;
  final String? publishedAt;
}

final _shaLine = RegExp(r'APK SHA-256:\s*`?([0-9a-fA-F]{64})`?');
final _version = RegExp(r'^v?(\d+)\.(\d+)\.(\d+)$');

/// A GitHub release → [AppRelease], or null when it has no Qline APK or no checksum (Qline never installs
/// a file it cannot check). When GitHub's asset digest and the checksum in the notes both exist they must agree.
AppRelease? parseRelease(Map<String, dynamic> j) {
  if (j['draft'] == true || j['prerelease'] == true) return null;
  final tag = '${j['tag_name'] ?? ''}';
  if (!_version.hasMatch(tag)) return null;
  final assets = ((j['assets'] as List?) ?? const []).whereType<Map>().map((a) => a.cast<String, dynamic>());
  final apk = assets.where((a) => RegExp(r'^qline-[\d.]+\.apk$').hasMatch('${a['name']}')).firstOrNull;
  final url = apk?['browser_download_url'] as String?;
  if (apk == null || url == null || !url.startsWith('https://github.com/')) return null;
  final body = '${j['body'] ?? ''}';
  final fromNotes = _shaLine.firstMatch(body)?.group(1)?.toLowerCase();
  final digest = '${apk['digest'] ?? ''}';
  final fromAsset = digest.startsWith('sha256:') ? digest.substring(7).toLowerCase() : null;
  if (fromNotes != null && fromAsset != null && fromNotes != fromAsset) return null;
  final sha = fromAsset ?? fromNotes;
  if (sha == null || !RegExp(r'^[0-9a-f]{64}$').hasMatch(sha)) return null;
  return AppRelease(
    version: tag.replaceFirst('v', ''),
    apkUrl: url,
    sha256: sha,
    size: (apk['size'] as num?)?.toInt(),
    notes: releaseNotes(body),
    pageUrl: j['html_url'] as String?,
    publishedAt: j['published_at'] as String?,
  );
}

/// Release notes as plain text: checksum lines and markdown marks removed, kept short.
String releaseNotes(String body) {
  final lines = body
      .split('\n')
      .where((l) => !l.contains('SHA-256'))
      .map((l) => l.replaceAll(RegExp(r'[*_`]'), '').replaceAll(RegExp(r'^#+\s*'), '').replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1]!).trimRight())
      .toList();
  final text = lines.join('\n').replaceAll(RegExp(r'\n{3,}'), '\n\n').trim();
  return text.length > 1500 ? '${text.substring(0, 1500).trimRight()}…' : text;
}

/// Compares x.y.z versions: negative when [a] is older than [b].
int compareVersions(String a, String b) {
  List<int> p(String v) {
    final m = _version.firstMatch(v.trim());
    return m == null ? [0, 0, 0] : [for (var i = 1; i <= 3; i++) int.parse(m.group(i)!)];
  }

  final x = p(a), y = p(b);
  for (var i = 0; i < 3; i++) {
    if (x[i] != y[i]) return x[i] - y[i];
  }
  return 0;
}

/// The Android side (MainActivity → Updater.kt). Tests replace it.
class UpdatePlatform {
  static const _ch = MethodChannel('qline/updater');
  void Function(String status, String? message)? onStatus;

  UpdatePlatform() {
    _ch.setMethodCallHandler((c) async {
      if (c.method == 'status') {
        final m = (c.arguments as Map).cast<String, dynamic>();
        onStatus?.call('${m['status']}', m['message'] as String?);
      }
      return null;
    });
  }

  bool get supported => Platform.isAndroid;
  Future<String> updateDir() async => (await _ch.invokeMethod<String>('updateDir'))!;
  Future<String> installedVersion() async {
    try {
      final m = await _ch.invokeMapMethod<String, dynamic>('installedVersion');
      final v = m?['name'] as String?;
      return v == null || v.isEmpty ? AppConfig.version : v;
    } catch (_) {
      return AppConfig.version;
    }
  }

  Future<bool> canInstall() async => await _ch.invokeMethod<bool>('canInstall') ?? false;
  Future<void> openInstallSettings() => _ch.invokeMethod('openInstallSettings');
  Future<String> install(String path, String sha256) async => await _ch.invokeMethod<String>('install', {'path': path, 'sha256': sha256}) ?? 'error:Install failed.';
  Future<void> dismissNotice() async {
    try {
      await _ch.invokeMethod('dismissNotice');
    } catch (_) {}
  }

  Future<void> clear() async {
    try {
      await _ch.invokeMethod('clear');
    } catch (_) {}
  }
}

final updatePlatformProvider = Provider<UpdatePlatform>((_) => UpdatePlatform());
final updateHttpProvider = Provider<http.Client>((_) => http.Client());

/// Small key-value store for update state (snooze, notified version). Tests replace it.
class UpdateStore {
  static const _s = FlutterSecureStorage();
  Future<String?> read(String k) => _s.read(key: k);
  Future<void> write(String k, String v) => _s.write(key: k, value: v);
}

final updateStoreProvider = Provider<UpdateStore>((_) => UpdateStore());

enum UpdatePhase { idle, checking, upToDate, available, downloading, verifying, needsPermission, confirming, failed }

class UpdateState {
  const UpdateState({this.phase = UpdatePhase.idle, this.release, this.progress, this.message, this.snoozed = false, this.current, this.justUpdated, this.downloaded});
  final UpdatePhase phase;
  final AppRelease? release;
  final double? progress;
  final String? message;
  final bool snoozed;
  final String? current;
  final String? justUpdated;
  final String? downloaded;

  /// The banner shows unless the person chose Later (and it isn't mid-update).
  bool get showBanner => release != null && phase != UpdatePhase.upToDate && phase != UpdatePhase.idle && phase != UpdatePhase.checking && !(snoozed && phase == UpdatePhase.available);

  UpdateState copy({UpdatePhase? phase, AppRelease? release, double? progress, String? message, bool? snoozed, String? current, String? justUpdated, String? downloaded, bool clearMessage = false, bool clearProgress = false}) => UpdateState(
        phase: phase ?? this.phase,
        release: release ?? this.release,
        progress: clearProgress ? null : progress ?? this.progress,
        message: clearMessage ? null : message ?? this.message,
        snoozed: snoozed ?? this.snoozed,
        current: current ?? this.current,
        justUpdated: justUpdated ?? this.justUpdated,
        downloaded: downloaded ?? this.downloaded,
      );
}

final updaterProvider = NotifierProvider<Updater, UpdateState>(Updater.new);

class Updater extends Notifier<UpdateState> {
  DateTime? _lastCheck;
  bool _busy = false;

  UpdatePlatform get _p => ref.read(updatePlatformProvider);
  UpdateStore get _store => ref.read(updateStoreProvider);

  @override
  UpdateState build() {
    ref.read(updatePlatformProvider).onStatus = _onStatus;
    return const UpdateState();
  }

  /// On app start: says "Updated to X" once after an update, and removes the "tap to open" notification.
  Future<void> start() async {
    if (!_p.supported) return;
    final current = await _p.installedVersion();
    await _p.dismissNotice();
    final pending = await _store.read('update_installing');
    if (pending != null && compareVersions(current, pending) >= 0) {
      await _store.write('update_installing', '');
      await _p.clear();
      state = state.copy(current: current, justUpdated: current);
    } else {
      state = state.copy(current: current);
    }
  }

  void clearJustUpdated() => state = UpdateState(phase: state.phase, release: state.release, progress: state.progress, message: state.message, snoozed: state.snoozed, current: state.current, downloaded: state.downloaded);

  /// Looks for a newer release. Automatic checks run at most every [autoCheckEvery]; [manual] always checks.
  Future<void> check({bool manual = false, DateTime? now}) async {
    if (!_p.supported || _busy) return;
    final t = now ?? DateTime.now();
    if (!manual && _lastCheck != null && t.difference(_lastCheck!) < autoCheckEvery) return;
    if (const {UpdatePhase.downloading, UpdatePhase.verifying, UpdatePhase.confirming, UpdatePhase.needsPermission}.contains(state.phase)) return;
    _lastCheck = t;
    if (manual) state = state.copy(phase: UpdatePhase.checking, clearMessage: true);
    try {
      final current = state.current ?? await _p.installedVersion();
      final res = await ref.read(updateHttpProvider).get(Uri.parse(latestReleaseUrl), headers: {'accept': 'application/vnd.github+json', 'user-agent': 'Qline/$current'}).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) throw const HttpException('bad status');
      final rel = parseRelease((jsonDecode(res.body) as Map).cast<String, dynamic>());
      if (rel == null || compareVersions(rel.version, current) <= 0) {
        state = UpdateState(phase: UpdatePhase.upToDate, current: current, justUpdated: state.justUpdated);
        return;
      }
      final snooze = await _store.read('update_later');
      final parts = snooze?.split('|');
      final snoozed = !manual && parts != null && parts.length == 2 && parts[0] == rel.version && (DateTime.tryParse(parts[1])?.isAfter(t) ?? false);
      state = state.copy(phase: UpdatePhase.available, release: rel, snoozed: snoozed, current: current, clearMessage: true, clearProgress: true);
      if (await _store.read('update_notified') != rel.version) {
        await _store.write('update_notified', rel.version);
        await showLocalAlert(id: 7100, title: 'Qline ${rel.version} is available', body: 'Open Qline to update when it suits you.');
      }
    } catch (_) {
      if (manual) state = state.copy(phase: state.release == null ? UpdatePhase.failed : UpdatePhase.available, message: "Couldn't check for updates. Check your connection and try again.");
    }
  }

  /// Hides the banner for this version for [snoozeFor]. Settings → App updates still shows it.
  Future<void> later({DateTime? now}) async {
    final rel = state.release;
    if (rel == null) return;
    await _store.write('update_later', '${rel.version}|${(now ?? DateTime.now()).add(snoozeFor).toUtc().toIso8601String()}');
    state = state.copy(phase: UpdatePhase.available, snoozed: true, clearMessage: true);
  }

  /// Downloads the APK (checking its SHA-256 while it streams in), then installs it.
  Future<void> update() async {
    final rel = state.release;
    if (rel == null || _busy) return;
    if (state.downloaded != null && File(state.downloaded!).existsSync()) return install();
    _busy = true;
    state = state.copy(phase: UpdatePhase.downloading, progress: 0, snoozed: false, clearMessage: true);
    File? part;
    try {
      final dir = await _p.updateDir();
      part = File('$dir/qline-${rel.version}.apk.part');
      final req = http.Request('GET', Uri.parse(rel.apkUrl))..headers['user-agent'] = 'Qline/${state.current ?? AppConfig.version}';
      final res = await ref.read(updateHttpProvider).send(req).timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) throw const HttpException('download');
      final total = res.contentLength ?? rel.size;
      if (total != null && total > updateMaxBytes) throw const FormatException('too large');
      final sink = part.openWrite();
      final digest = _DigestSink();
      final hasher = sha256.startChunkedConversion(digest);
      var got = 0;
      var lastShown = 0.0;
      try {
        await for (final chunk in res.stream.timeout(const Duration(seconds: 60))) {
          got += chunk.length;
          if (got > updateMaxBytes) throw const FormatException('too large');
          hasher.add(chunk);
          sink.add(chunk);
          if (total != null && total > 0) {
            final p = (got / total).clamp(0.0, 1.0);
            if (p - lastShown >= .01 || p == 1) {
              lastShown = p;
              state = state.copy(progress: p);
            }
          }
        }
      } finally {
        await sink.close();
      }
      hasher.close();
      state = state.copy(phase: UpdatePhase.verifying, clearProgress: true);
      if (digest.value.toString() != rel.sha256) {
        await part.delete();
        state = state.copy(phase: UpdatePhase.failed, message: "The download didn't match the release checksum, so Qline deleted it. Try again.");
        return;
      }
      final apk = await part.rename('$dir/qline-${rel.version}.apk');
      state = state.copy(downloaded: apk.path);
    } catch (e) {
      try {
        await part?.delete();
      } catch (_) {}
      state = state.copy(phase: UpdatePhase.failed, clearProgress: true, message: e is FormatException ? 'This update is too large to download in the app. Use the release page instead.' : "The download stopped. Check your connection and try again.");
      return;
    } finally {
      _busy = false;
    }
    await install();
  }

  /// Hands the checked APK to Android. Asks for "Install unknown apps" first when needed.
  Future<void> install() async {
    final rel = state.release, path = state.downloaded;
    if (rel == null || path == null) return;
    try {
      if (!await _p.canInstall()) {
        state = state.copy(phase: UpdatePhase.needsPermission, clearMessage: true);
        return;
      }
      await _store.write('update_installing', rel.version);
      final r = await _p.install(path, rel.sha256);
      if (r == 'pending') {
        state = state.copy(phase: UpdatePhase.confirming, clearMessage: true);
      } else if (r == 'error:permission') {
        state = state.copy(phase: UpdatePhase.needsPermission, clearMessage: true);
      } else {
        state = state.copy(phase: UpdatePhase.failed, message: r.replaceFirst('error:', ''));
      }
    } catch (e) {
      state = state.copy(phase: UpdatePhase.failed, message: e is PlatformException ? (e.message ?? 'Install failed.') : 'Install failed.');
    }
  }

  Future<void> openInstallSettings() => _p.openInstallSettings();

  /// Back from Android settings: continue when the permission is now on.
  Future<void> resumed() async {
    if (state.phase == UpdatePhase.needsPermission && await _p.canInstall()) await install();
  }

  void _onStatus(String status, String? message) {
    switch (status) {
      case 'confirming':
        state = state.copy(phase: UpdatePhase.confirming);
      case 'cancelled':
        // The person said no on Android's screen: keep the download, offer it again without forcing.
        state = state.copy(phase: UpdatePhase.available, message: 'Update not installed. You can install it any time.');
      case 'failed':
        state = state.copy(phase: UpdatePhase.failed, message: message ?? 'The update was not installed.');
      case 'installed':
        break; // Android ends this process; UpdatedReceiver reopens Qline.
    }
  }
}

class _DigestSink implements Sink<Digest> {
  late Digest value;
  @override
  void add(Digest d) => value = d;
  @override
  void close() {}
}

/// Checks on start and when Qline comes back to the foreground. Off in widget tests unless [enabled].
class UpdateWatcher extends ConsumerStatefulWidget {
  const UpdateWatcher({super.key, required this.child, this.enabled});
  final Widget child;
  final bool? enabled;
  @override
  ConsumerState<UpdateWatcher> createState() => _UpdateWatcherState();
}

class _UpdateWatcherState extends ConsumerState<UpdateWatcher> with WidgetsBindingObserver {
  bool get _on => widget.enabled ?? !Platform.environment.containsKey('FLUTTER_TEST');

  @override
  void initState() {
    super.initState();
    if (!_on) return;
    WidgetsBinding.instance.addObserver(this);
    Future.microtask(() async {
      final u = ref.read(updaterProvider.notifier);
      await u.start();
      await u.check();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s != AppLifecycleState.resumed) return;
    final u = ref.read(updaterProvider.notifier);
    u.resumed();
    u.check();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
