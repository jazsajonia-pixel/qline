import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/alerts.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/content.dart';
import 'package:qline/screens/content_setup.dart';
import 'package:qline/ui/theme.dart';
import 'package:qline/ui/widgets.dart' show SkeletonList;

/// Run 6 (docs/22): Content Studio, Drive folder setup, Handoff Monitor, job detail and notification deep links.
/// Screenshots for review: `QLINE_SHOTS=1 flutter test test/v17_content_test.dart --update-goldens`
final shots = Platform.environment['QLINE_SHOTS'] == '1';

Future<void> loadFonts() async {
  for (final (fam, file) in [('HankenGrotesk', 'assets/fonts/HankenGrotesk.ttf'), ('JetBrainsMono', 'assets/fonts/JetBrainsMono.ttf'), ('MaterialIcons', null)]) {
    final loader = FontLoader(fam);
    if (file != null) {
      loader.addFont(Future.value(ByteData.sublistView(File(file).readAsBytesSync())));
    } else {
      final root = Platform.environment['FLUTTER_ROOT'] ?? '/tmp/flutter';
      final f = File('$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
      if (!f.existsSync()) continue;
      loader.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
    }
    await loader.load();
  }
}

class _Signed extends SessionNotifier {
  _Signed(this.role);
  final String role;
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'ana@shop.ph', orgs: [Org('o1', 'Shop', role)], orgId: 'o1');
}

http.Response _json(Object? body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

/// Records every request; routes are "METHOD /path" → body (or a function of the request).
class Server {
  Server(this.routes);
  final Map<String, Object? Function(http.Request r)> routes;
  final calls = <http.Request>[];
  bool offline = false;
  late final client = MockClient((r) async {
    calls.add(r);
    if (offline) throw const SocketException('offline');
    final key = '${r.method} ${r.url.path.replaceFirst('/v1', '')}';
    final h = routes[key];
    if (h == null) return _json({'title': 'Not found', 'code': 'NOT_FOUND'}, 404);
    final out = h(r);
    return out is http.Response ? out : _json(out);
  });
  Iterable<http.Request> hits(String method, String path) => calls.where((r) => r.method == method && r.url.path.endsWith(path));
}

Widget app(Server s, Widget home, {String role = 'owner', bool light = false, double textScale = 1}) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(Api(client: s.client)), sessionProvider.overrideWith(() => _Signed(role))],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildTheme(light),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
        home: home,
      ),
    );

/// A 390 px wide phone (390 × 2.625 = 1023.75 physical px).
void phone(WidgetTester t, {double height = 844}) {
  t.view.physicalSize = Size(390 * 2.625, height * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
}

Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 12; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

final now = DateTime.now().toUtc();
String hoursAgo(int h) => now.subtract(Duration(hours: h)).toIso8601String();

Map<String, Object?> cfg({String status = 'valid'}) => {
      'status': status,
      'rootFolderId': 'root1',
      'roles': {'assets': ['src1'], 'ready_for_qa': 'qa1', 'external_reports': 'rep1', 'logs': 'log1'},
      'validation': {
        'ok': status == 'valid',
        'root': {'folderId': 'root1', 'name': 'Shop videos', 'ok': true, 'reason': null},
        'folders': [
          {'role': 'assets', 'folderId': 'src1', 'name': 'Raw footage', 'ok': true, 'reason': null},
          {'role': 'ready_for_qa', 'folderId': 'qa1', 'name': 'Ready for QA', 'ok': status == 'valid', 'reason': status == 'valid' ? null : 'outside_root'},
        ],
      },
      'lastSuccessAt': hoursAgo(1),
      'lastError': null,
      'changes': {'watching': false},
    };

Map<String, Object?> job(String id, String state, {String? ext, bool stale = false, String title = 'Spring promo, 30 seconds'}) => {
      'id': id,
      'jobCode': 'QJ-20261120-${id.substring(0, 4).toUpperCase()}',
      'title': title,
      'brief': 'Bright, fast cuts.',
      'state': state,
      'externalStatus': ext,
      'revision': 1,
      'inputFileIds': ['f1', 'f2'],
      'expectedOutputs': [
        {'kind': 'video', 'fileName': 'QJ-20261120-${id.substring(0, 4).toUpperCase()}-r1.mp4'},
      ],
      'qaTaskId': state == 'awaiting_video_qa' ? '11111111-2222-3333-4444-555555555555' : null,
      'lastError': null,
      'cancelReason': null,
      'createdAt': hoursAgo(100),
      'lastActivityAt': hoursAgo(stale ? 80 : 2),
      'expiresAt': now.add(const Duration(days: 10)).toIso8601String(),
      'stale': stale,
      'staleSince': stale ? hoursAgo(8) : null,
    };

const idA = 'aaaa0000-0000-4000-8000-000000000001';
const idB = 'bbbb0000-0000-4000-8000-000000000002';

Map<String, Object?> detail(String state, {String? ext, bool stale = false}) => {
      ...job(idA, state, ext: ext, stale: stale),
      'events': [
        {'source': 'qline', 'event_key': 'created:r1', 'revision': 1, 'sequence': null, 'event_type': 'job.created', 'message': 'Job created with 2 source file(s).', 'occurred_at': hoursAgo(100)},
        {'source': 'external', 'event_key': 'e1', 'revision': 1, 'sequence': 1, 'event_type': 'report.in_progress', 'message': 'Started the rough cut, all done soon', 'occurred_at': hoursAgo(80)},
      ],
      'outputs': [
        if (state == 'needs_manual_review')
          {
            'revision': 1,
            'drive_file_id': 'v1',
            'name': 'QJ-20261120-AAAA-r1.mp4',
            'mime': 'video/mp4',
            'size_bytes': '48234567',
            'verification': 'rejected',
            'findings': [
              {'code': 'ASPECT', 'message': 'The video is 16:9 but the job asks for 9:16.'},
            ],
            'verified_at': hoursAgo(1),
          },
      ],
      'acks': [
        {'revision': 1, 'version': 1, 'status': 'in_progress', 'findings': <Object>[], 'created_at': hoursAgo(80)},
      ],
    };

final manifest = {
  'jobCode': 'QJ-20261120-AAAA',
  'inputs': [
    {'driveFileId': 'f1', 'name': 'storefront-wide.mov', 'mimeType': 'video/quicktime', 'sizeBytes': 734003200},
    {'driveFileId': 'f2', 'name': 'logo.png', 'mimeType': 'image/png', 'sizeBytes': 20480},
  ],
};

Server studio({Object? cfgBody, List<Object?>? jobs}) => Server({
      'GET /content/drive-config': (_) => cfgBody ?? cfg(),
      'GET /content/jobs': (r) => {
            'items': jobs ??
                [
                  job(idA, 'external_in_progress', ext: 'in_progress', stale: true),
                  job(idB, 'awaiting_video_qa', ext: 'completed', title: 'Menu launch reel'),
                ],
            'filter': r.url.queryParameters['filter'],
          },
      'POST /content/reports/check': (_) => {'listed': 2, 'read': 2, 'applied': 1, 'duplicates': 1, 'rejected': 0, 'recorded': 0, 'tampered': 0, 'deferred': 0, 'skipped': <Object>[]},
    });

Server jobServer(Map<String, Object?> d, {Object? manifestOut}) => Server({
      'GET /content/jobs/$idA': (_) => d,
      'GET /content/jobs/$idA/manifest': (_) => manifestOut ?? manifest,
      'POST /content/jobs/$idA/cancel': (_) => {...d, 'state': 'cancelled'},
      'POST /content/jobs/$idA/ingest': (_) => {'outcome': 'applied', 'findings': <Object>[], 'job': d},
      'POST /content/jobs/$idA/reissue': (_) => {...d, 'revision': 2},
    });

void main() {
  setUpAll(loadFonts);

  group('pure helpers', () {
    test('driveIdFrom takes bare IDs and Drive links only', () {
      expect(driveIdFrom('1AbC_d-9'), '1AbC_d-9');
      expect(driveIdFrom(' https://drive.google.com/drive/folders/1AbCd?usp=sharing '), '1AbCd');
      expect(driveIdFrom('https://drive.google.com/open?id=XyZ'), 'XyZ');
      expect(driveIdFrom('https://evil.example.com/drive/folders/1AbCd'), isNull);
      expect(driveIdFrom('not a link'), isNull);
      expect(driveIdFrom(''), isNull);
    });

    test('notification payload only for content jobs, and it opens the job', () {
      final p = alertPayload({'ref': {'kind': 'content_job', 'id': idA, 'jobCode': 'QJ-1'}});
      expect(p, isNotNull);
      expect(pageForRef(p), isA<ContentJobScreen>().having((s) => s.id, 'id', idA));
      expect(alertPayload({'ref': jsonEncode({'kind': 'content_job', 'id': idA})}), isNotNull);
      expect(alertPayload({'ref': {'kind': 'lead', 'id': idA}}), isNull);
      expect(alertPayload({'ref': null}), isNull);
      expect(pageForRef({'kind': 'content_job', 'id': '../x'}), isNull);
      expect(pageForRef('not json'), isNull);
    });

    test('every Qline state has a word, and the editor claim has its own words', () {
      for (final s in ['prepared', 'dispatched', 'external_acknowledged', 'external_in_progress', 'result_received', 'validating_output', 'output_verified', 'awaiting_video_qa', 'needs_manual_review', 'failed', 'blocked', 'expired', 'cancelled']) {
        final (_, _, word, _) = contentState(QColors.dark, s);
        expect(word, isNot(contains('_')), reason: s);
      }
      expect(editorSays(null), 'No report yet');
      expect(editorSays('completed'), 'Says it is done');
    });
  });

  group('Content Studio', () {
    testWidgets('loading, then the monitor with both states on each row', (t) async {
      phone(t);
      final s = studio();
      await t.pumpWidget(app(s, const ContentStudioScreen()));
      expect(find.byType(SkeletonList), findsOneWidget);
      await settle(t);
      expect(find.text('Drive folders ready'), findsOneWidget);
      expect(find.text('Spring promo, 30 seconds'), findsOneWidget);
      expect(find.text('Editor working'), findsOneWidget);
      expect(find.text('Editor: In progress'), findsOneWidget);
      expect(find.text('Waiting for your review'), findsOneWidget);
      expect(find.text('Editor: Says it is done'), findsOneWidget);
      expect(find.text('No news for 3+ days'), findsOneWidget);
      expect(find.text('New handoff'), findsOneWidget);
      expect(s.hits('GET', '/content/jobs').first.url.queryParameters['filter'], 'active');
    });

    testWidgets('rows read both ledgers to screen readers', (t) async {
      phone(t);
      final h = t.ensureSemantics();
      await t.pumpWidget(app(studio(), const ContentStudioScreen()));
      await settle(t);
      expect(find.bySemanticsLabel(RegExp(r'Spring promo, 30 seconds\. Qline: Editor working\. Editor: In progress\. No news for over 3 days\.')), findsOneWidget);
      h.dispose();
    });

    testWidgets('filters ask the server again', (t) async {
      phone(t);
      final s = studio();
      await t.pumpWidget(app(s, const ContentStudioScreen()));
      await settle(t);
      await t.tap(find.text('Your review'));
      await settle(t);
      expect(s.hits('GET', '/content/jobs').last.url.queryParameters['filter'], 'awaiting');
    });

    testWidgets('check Drive for reports says what happened', (t) async {
      phone(t);
      final s = studio();
      await t.pumpWidget(app(s, const ContentStudioScreen(), role: 'member'));
      await settle(t);
      await t.tap(find.text('Check Drive for reports'));
      await settle(t);
      expect(s.hits('POST', '/content/reports/check'), hasLength(1));
      expect(find.text('1 new report read.'), findsOneWidget);
    });

    testWidgets('empty and not set up: owner is told to set up folders, no New handoff', (t) async {
      phone(t);
      await t.pumpWidget(app(studio(cfgBody: {'status': 'unconfigured', 'roles': null}, jobs: []), const ContentStudioScreen()));
      await settle(t);
      expect(find.text('No Drive folders yet'), findsOneWidget);
      expect(find.text('No handoffs yet'), findsOneWidget);
      expect(find.textContaining('Set up the Drive folders first'), findsOneWidget);
      expect(find.text('New handoff'), findsNothing);
      expect(find.text('Check Drive for reports'), findsNothing);
    });

    testWidgets('viewer: can look, cannot start or check', (t) async {
      phone(t);
      await t.pumpWidget(app(studio(), const ContentStudioScreen(), role: 'viewer'));
      await settle(t);
      expect(find.text('Spring promo, 30 seconds'), findsOneWidget);
      expect(find.text('New handoff'), findsNothing);
      expect(find.text('Check Drive for reports'), findsNothing);
    });

    testWidgets('offline shows the offline panel with Try again', (t) async {
      phone(t);
      final s = studio()..offline = true;
      await t.pumpWidget(app(s, const ContentStudioScreen()));
      await settle(t);
      expect(find.text("You're offline"), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });

    testWidgets('server error shows the error panel', (t) async {
      phone(t);
      final s = Server({'GET /content/drive-config': (_) => _json({'title': 'Server error', 'code': 'INTERNAL'}, 500)});
      await t.pumpWidget(app(s, const ContentStudioScreen()));
      await settle(t);
      expect(find.text("Couldn't load this"), findsOneWidget);
    });

    testWidgets('an older server without content routes gets a plain explanation', (t) async {
      phone(t);
      await t.pumpWidget(app(Server({}), const ContentStudioScreen()));
      await settle(t);
      expect(find.text('Content Studio is not on your server yet'), findsOneWidget);
      expect(find.text("Couldn't load this"), findsNothing);
    });

    for (final light in [false, true]) {
      testWidgets('screenshot ${light ? 'light' : 'dark'} at 390 px', (t) async {
        phone(t);
        await t.pumpWidget(app(studio(), const ContentStudioScreen(), light: light));
        await settle(t);
        expect(t.takeException(), isNull);
        if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/content_studio_${light ? 'light' : 'dark'}.png'));
      });
    }
  });

  group('Drive folder setup', () {
    testWidgets('save keeps folders not shown on the form, then checks them', (t) async {
      phone(t, height: 1400);
      final put = <Map>[];
      final s = Server({
        'GET /content/drive-config': (_) => cfg(status: 'invalid'),
        'PUT /content/drive-config': (r) {
          put.add(jsonDecode(r.body) as Map);
          return cfg(status: 'needs_revalidation');
        },
        'POST /content/drive-config/validate': (_) => cfg(),
      });
      await t.pumpWidget(app(s, const DriveFolderSetupScreen()));
      await settle(t);
      expect(find.text('Some folders need a fix'), findsWidgets);
      expect(find.textContaining('not inside the main folder'), findsOneWidget);
      await t.tap(find.text('Save and check folders'));
      await settle(t);
      expect(put, hasLength(1));
      expect(put.single['rootFolderId'], 'root1');
      expect((put.single['roles'] as Map)['logs'], 'log1');
      expect((put.single['roles'] as Map)['assets'], ['src1']);
      expect(s.hits('POST', '/content/drive-config/validate'), hasLength(1));
    });

    testWidgets('a bad link is refused before anything is sent', (t) async {
      phone(t, height: 1400);
      final s = Server({'GET /content/drive-config': (_) => {'status': 'unconfigured', 'roles': null}});
      await t.pumpWidget(app(s, const DriveFolderSetupScreen()));
      await settle(t);
      await t.enterText(find.widgetWithText(TextField, 'Main folder'), 'https://evil.example.com/folders/x');
      await t.tap(find.text('Save and check folders'));
      await settle(t);
      expect(find.text('Paste a Drive folder link or ID'), findsOneWidget);
      expect(s.hits('PUT', '/content/drive-config'), isEmpty);
    });

    testWidgets('members see the folders read-only', (t) async {
      phone(t, height: 1400);
      await t.pumpWidget(app(Server({'GET /content/drive-config': (_) => cfg()}), const DriveFolderSetupScreen(), role: 'member'));
      await settle(t);
      expect(find.text('Save and check folders'), findsNothing);
      expect(find.text('Sync now'), findsNothing);
    });

    for (final light in [false, true]) {
      testWidgets('screenshot ${light ? 'light' : 'dark'}', (t) async {
        phone(t);
        await t.pumpWidget(app(Server({'GET /content/drive-config': (_) => cfg(status: 'invalid')}), const DriveFolderSetupScreen(), light: light));
        await settle(t);
        expect(t.takeException(), isNull);
        if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/content_setup_${light ? 'light' : 'dark'}.png'));
      });
    }
  });

  group('Job detail', () {
    testWidgets('two ledgers, stale note, inputs and the editor quoted as the editor', (t) async {
      phone(t, height: 2200);
      await t.pumpWidget(app(jobServer(detail('external_in_progress', ext: 'in_progress', stale: true)), const ContentJobScreen(id: idA)));
      await settle(t);
      expect(find.text('Qline checked'), findsOneWidget);
      expect(find.text('Editor says'), findsOneWidget);
      expect(find.text('Editor working'), findsOneWidget);
      expect(find.text('In progress'), findsOneWidget);
      expect(find.textContaining('not trusted until Qline checks'), findsOneWidget);
      expect(find.textContaining('No news from the editor for over 3 days'), findsOneWidget);
      expect(find.text('storefront-wide.mov'), findsOneWidget);
      expect(find.text('Editor wrote: Started the rough cut, all done soon'), findsOneWidget);
      expect(find.text('Cancel job'), findsOneWidget);
    });

    testWidgets('rejected video shows what Qline found', (t) async {
      phone(t, height: 2200);
      await t.pumpWidget(app(jobServer(detail('needs_manual_review', ext: 'completed')), const ContentJobScreen(id: idA)));
      await settle(t);
      expect(find.text('Needs a check'), findsOneWidget);
      expect(find.text('Refused'), findsOneWidget);
      expect(find.text('The video is 16:9 but the job asks for 9:16.'), findsOneWidget);
      expect(find.text('46.0 MB · revision 1'), findsOneWidget);
    });

    testWidgets('waiting for review opens the review task', (t) async {
      phone(t);
      await t.pumpWidget(app(jobServer(detail('awaiting_video_qa', ext: 'completed')), const ContentJobScreen(id: idA)));
      await settle(t);
      expect(find.text('Open review task'), findsOneWidget);
      expect(find.text('Reissue'), findsNothing);
    });

    testWidgets('a broken checksum says not to send', (t) async {
      phone(t);
      final s = jobServer(detail('prepared'), manifestOut: _json({'title': 'Integrity', 'code': 'INTEGRITY_FAILED'}, 409));
      await t.pumpWidget(app(s, const ContentJobScreen(id: idA)));
      await settle(t);
      expect(find.textContaining("Don't send this job"), findsOneWidget);
    });

    testWidgets('cancel needs a confirmation', (t) async {
      phone(t, height: 2200);
      final s = jobServer(detail('dispatched'));
      await t.pumpWidget(app(s, const ContentJobScreen(id: idA), role: 'member'));
      await settle(t);
      await t.ensureVisible(find.text('Cancel job'));
      await t.tap(find.text('Cancel job'));
      await settle(t);
      expect(find.text('Cancel this job?'), findsOneWidget);
      await t.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Cancel')));
      await settle(t);
      expect(s.hits('POST', '/cancel'), isEmpty);
      await t.tap(find.text('Cancel job'));
      await settle(t);
      await t.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Cancel job')));
      await settle(t);
      expect(s.hits('POST', '/cancel'), hasLength(1));
      expect(jsonDecode(s.hits('POST', '/cancel').single.body), {'confirm': true});
    });

    testWidgets('a pasted report is sent exactly as pasted', (t) async {
      phone(t, height: 2200);
      final s = jobServer(detail('dispatched'));
      await t.pumpWidget(app(s, const ContentJobScreen(id: idA), role: 'member'));
      await settle(t);
      const raw = '{"jobCode":"QJ-20261120-AAAA","revision":1,"status":"accepted"}';
      // The dialog starts with what is on the clipboard.
      t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (c) async => c.method == 'Clipboard.getData' ? {'text': raw} : null);
      addTearDown(() => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await t.ensureVisible(find.text('Paste a result file'));
      await t.tap(find.text('Paste a result file'));
      await settle(t);
      expect(find.descendant(of: find.byType(AlertDialog), matching: find.text(raw)), findsOneWidget);
      await t.tap(find.text('Read it'));
      await settle(t);
      expect(s.hits('POST', '/ingest').single.body, raw);
      expect(find.text('Report read. Qline updated the job.'), findsOneWidget);
    });

    testWidgets('viewer can only download', (t) async {
      phone(t, height: 2200);
      await t.pumpWidget(app(jobServer(detail('dispatched')), const ContentJobScreen(id: idA), role: 'viewer'));
      await settle(t);
      expect(find.text('Save editor PDF'), findsOneWidget);
      expect(find.text('Cancel job'), findsNothing);
      expect(find.text('Paste a result file'), findsNothing);
      expect(find.textContaining('You can view this job'), findsOneWidget);
    });

    testWidgets('no overflow at 130% text size', (t) async {
      phone(t, height: 2600);
      await t.pumpWidget(app(jobServer(detail('needs_manual_review', ext: 'completed', stale: true)), const ContentJobScreen(id: idA), textScale: 1.3));
      await settle(t);
      expect(t.takeException(), isNull);
      await t.pumpWidget(app(studio(), const ContentStudioScreen(), textScale: 1.3));
      await settle(t);
      expect(t.takeException(), isNull);
    });

    for (final light in [false, true]) {
      testWidgets('screenshot ${light ? 'light' : 'dark'}', (t) async {
        phone(t);
        await t.pumpWidget(app(jobServer(detail('external_in_progress', ext: 'in_progress', stale: true)), const ContentJobScreen(id: idA), light: light));
        await settle(t);
        expect(t.takeException(), isNull);
        if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/content_job_${light ? 'light' : 'dark'}.png'));
      });
    }
  });
}
