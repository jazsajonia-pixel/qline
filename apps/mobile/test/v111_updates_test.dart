import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/updater.dart';
import 'package:qline/ui/theme.dart';
import 'package:qline/ui/update_banner.dart';

/// v1.11 (docs/28): in-app updates. Never forced, checksum-checked, Android confirms the install.

final apk = utf8.encode('PK fake signed qline apk bytes ' * 400);
final apkSha = sha256.convert(apk).toString();

Map<String, dynamic> release({String tag = 'v1.11.0', String? digest, String? notesSha, String name = 'qline-1.11.0.apk', String url = 'https://github.com/jazsajonia-pixel/qline/releases/download/v1.11.0/qline-1.11.0.apk'}) => {
      'tag_name': tag,
      'draft': false,
      'prerelease': false,
      'html_url': 'https://github.com/jazsajonia-pixel/qline/releases/tag/$tag',
      'body': '# Qline 1.11\n\n- **Facebook Pages** posting with approval\n- [Voice v2](https://x.test)\n\nAPK SHA-256: `${notesSha ?? apkSha}`\nSigning certificate SHA-256: `042819cb`',
      'assets': [
        {'name': name, 'browser_download_url': url, 'size': apk.length, 'digest': ?digest},
      ],
    };

class FakePlatform extends UpdatePlatform {
  FakePlatform(this.dir);
  final String dir;
  bool allowed = true;
  final installs = <(String, String)>[];
  String result = 'pending';
  int settingsOpened = 0;
  @override
  bool get supported => true;
  @override
  Future<String> updateDir() async => dir;
  @override
  Future<String> installedVersion() async => '1.10.0';
  @override
  Future<bool> canInstall() async => allowed;
  @override
  Future<void> openInstallSettings() async => settingsOpened++;
  @override
  Future<String> install(String path, String sha256) async {
    installs.add((path, sha256));
    return result;
  }

  @override
  Future<void> dismissNotice() async {}
  @override
  Future<void> clear() async {}
}

class MemStore extends UpdateStore {
  final m = <String, String>{};
  @override
  Future<String?> read(String k) async => m[k];
  @override
  Future<void> write(String k, String v) async => m[k] = v;
}

class Rig {
  Rig({Map<String, dynamic>? rel, List<int>? bytes}) {
    dir = Directory.systemTemp.createTempSync('qline-upd');
    platform = FakePlatform(dir.path);
    client = MockClient((r) async {
      calls.add(r);
      if (r.url.toString() == latestReleaseUrl) return http.Response(jsonEncode(rel ?? release()), 200);
      if (r.url.host == 'github.com') return http.Response.bytes(bytes ?? apk, 200);
      return http.Response('', 404);
    });
    c = ProviderContainer(overrides: [updatePlatformProvider.overrideWithValue(platform), updateHttpProvider.overrideWithValue(client), updateStoreProvider.overrideWithValue(store)]);
  }
  late final Directory dir;
  late final FakePlatform platform;
  late final MockClient client;
  final store = MemStore();
  final calls = <http.Request>[];
  late final ProviderContainer c;
  Updater get u => c.read(updaterProvider.notifier);
  UpdateState get s => c.read(updaterProvider);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('release parsing', () {
    test('uses GitHub\'s asset digest or the checksum in the notes, and refuses anything it cannot check', () {
      final a = parseRelease(release())!;
      expect(a.version, '1.11.0');
      expect(a.sha256, apkSha);
      expect(a.size, apk.length);
      expect(a.notes, contains('Facebook Pages posting with approval'));
      expect(a.notes, isNot(contains('SHA-256')));
      expect(a.notes, contains('Voice v2'));
      expect(parseRelease(release(digest: 'sha256:$apkSha'))!.sha256, apkSha);
      expect(parseRelease(release(digest: 'sha256:${'0' * 64}')), isNull, reason: 'digest and notes disagree');
      expect(parseRelease(release(notesSha: 'nope')), isNull, reason: 'no checksum at all');
      expect(parseRelease(release(url: 'https://evil.test/qline-1.11.0.apk')), isNull);
      expect(parseRelease(release(name: 'other.apk')), isNull);
      expect(parseRelease({...release(), 'prerelease': true}), isNull);
      expect(parseRelease(release(tag: 'nightly')), isNull);
    });

    test('version comparison', () {
      expect(compareVersions('1.11.0', '1.10.0'), greaterThan(0));
      expect(compareVersions('1.9.9', '1.10.0'), lessThan(0));
      expect(compareVersions('v2.0.0', '2.0.0'), 0);
    });
  });

  group('updater', () {
    test('finds a newer version, notifies once, Later hides the banner for 3 days, manual check shows it again', () async {
      final r = Rig();
      await r.u.check();
      expect(r.s.phase, UpdatePhase.available);
      expect(r.s.showBanner, isTrue);
      expect(r.store.m['update_notified'], '1.11.0');
      final t = DateTime.now();
      await r.u.later(now: t);
      expect(r.s.showBanner, isFalse);
      // A fresh start inside the snooze stays quiet; nothing is downloaded without a tap.
      final r2 = Rig()..store.m.addAll(r.store.m);
      await r2.u.check();
      expect(r2.s.phase, UpdatePhase.available);
      expect(r2.s.showBanner, isFalse);
      expect(r2.calls.where((c) => c.url.host == 'github.com'), isEmpty);
      await r2.u.check(manual: true);
      expect(r2.s.showBanner, isTrue);
      // After the snooze ends it comes back.
      final r3 = Rig()..store.m.addAll(r.store.m);
      await r3.u.check(now: t.add(const Duration(days: 4)));
      expect(r3.s.showBanner, isTrue);
    });

    test('up to date when the release is not newer; automatic checks are throttled', () async {
      final r = Rig(rel: release(tag: 'v1.10.0', name: 'qline-1.10.0.apk'));
      await r.u.check();
      expect(r.s.phase, UpdatePhase.upToDate);
      expect(r.s.showBanner, isFalse);
      await r.u.check();
      expect(r.calls.length, 1);
      await r.u.check(manual: true);
      expect(r.calls.length, 2);
    });

    test('download is checked, then needs the install permission, then hands the APK to Android', () async {
      final r = Rig();
      r.platform.allowed = false;
      await r.u.check();
      await r.u.update();
      expect(r.s.phase, UpdatePhase.needsPermission);
      final path = r.s.downloaded!;
      expect(File(path).readAsBytesSync(), apk);
      expect(File('$path.part').existsSync(), isFalse);
      await r.u.openInstallSettings();
      expect(r.platform.settingsOpened, 1);
      r.platform.allowed = true;
      await r.u.resumed();
      expect(r.platform.installs.single, (path, apkSha));
      expect(r.s.phase, UpdatePhase.confirming);
      expect(r.store.m['update_installing'], '1.11.0');
      // The person cancels on Android's screen: nothing is forced, the update stays offered.
      r.platform.onStatus!('cancelled', null);
      expect(r.s.phase, UpdatePhase.available);
      expect(r.s.message, contains('any time'));
      // Trying again reuses the checked download.
      await r.u.update();
      expect(r.calls.where((c) => c.url.host == 'github.com').length, 1);
      expect(r.platform.installs.length, 2);
    });

    test('a download that does not match the checksum is deleted and never installed', () async {
      final r = Rig(bytes: utf8.encode('tampered'));
      await r.u.check();
      await r.u.update();
      expect(r.s.phase, UpdatePhase.failed);
      expect(r.s.message, contains('checksum'));
      expect(r.platform.installs, isEmpty);
      expect(r.dir.listSync(), isEmpty);
    });

    test('Android refusing (wrong signer, failure) is reported in plain words', () async {
      final r = Rig();
      r.platform.result = "error:This update is not signed by Qline's key. Install it from the GitHub release page instead.";
      await r.u.check();
      await r.u.update();
      expect(r.s.phase, UpdatePhase.failed);
      expect(r.s.message, startsWith('This update is not signed'));
      r.platform.onStatus!('failed', 'Not enough storage to install the update.');
      expect(r.s.message, 'Not enough storage to install the update.');
    });

    test('after an update Qline says so once', () async {
      final r = Rig()..store.m['update_installing'] = '1.10.0';
      await r.u.start();
      expect(r.s.justUpdated, '1.10.0');
      expect(r.store.m['update_installing'], '');
    });
  });

  testWidgets('banner: Update / Later, progress, and nothing blocks the app', (t) async {
    final r = Rig();
    await r.u.check();
    await t.pumpWidget(UncontrolledProviderScope(
      container: r.c,
      child: MaterialApp(theme: buildTheme(false), home: const Scaffold(body: Column(children: [UpdateBanner(), Expanded(child: Center(child: Text('Home')))]))),
    ));
    await t.pump();
    expect(find.text('Qline 1.11.0 is available'), findsOneWidget);
    expect(find.text('Home'), findsOneWidget);
    await t.tap(find.text("What's new"));
    await t.pumpAndSettle();
    expect(find.textContaining('Facebook Pages posting'), findsOneWidget);
    await t.tapAt(const Offset(10, 10));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('update-later')));
    await t.pumpAndSettle();
    expect(find.text('Qline 1.11.0 is available'), findsNothing);
    expect(t.takeException(), isNull);
  });

  testWidgets('Settings → App updates: manual check shows the card even after Later', (t) async {
    final r = Rig();
    await r.u.check();
    await r.u.later();
    await t.pumpWidget(UncontrolledProviderScope(container: r.c, child: MaterialApp(theme: buildTheme(true), home: const UpdatesScreen())));
    await t.pump();
    expect(find.text('1.10.0'), findsOneWidget);
    await t.runAsync(() => r.u.check(manual: true));
    await t.pump();
    expect(find.text('Qline 1.11.0 is available'), findsOneWidget);
    expect(find.byKey(const Key('update-now')), findsOneWidget);
  });
}
