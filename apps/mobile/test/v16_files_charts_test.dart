import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/ui/chat_artifacts.dart';
import 'package:qline/ui/theme.dart';

/// v1.6 run 2: files sent to the AI, and the charts/images it shows back.
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');

Api _api(List<String> calls, Future<http.Response> Function(http.Request r) reply) => Api(
      client: MockClient((r) async {
        calls.add('${r.method} ${r.url.path}');
        return reply(r);
      }),
    );

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Widget _wrap(Widget child, {Api? api, bool reduceMotion = false}) => ProviderScope(
      overrides: [if (api != null) apiProvider.overrideWithValue(api)],
      child: MaterialApp(
        theme: buildTheme(false),
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: reduceMotion, size: const Size(390, 844)),
          child: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child)),
        ),
      ),
    );

Map<String, dynamic> _bar({bool computed = true}) => {
      'type': 'chart',
      'chart': 'bar',
      'title': 'Leads by source',
      'labels': ['Web', 'Referral', 'Ads'],
      'series': [
        {'name': 'Leads', 'values': [12, 5, 3]},
      ],
      'source': computed ? 'Qline data' : 'Sheet: Sales 2026, tab Q3',
      'computed': computed,
    };

void main() {
  group('chart data', () {
    test('drops series that do not line up with the labels', () {
      final c = ChartData.parse({
        'chart': 'line',
        'title': 'T',
        'labels': ['a', 'b'],
        'series': [
          {'name': 'ok', 'values': [1, 2]},
          {'name': 'bad', 'values': [1]},
        ],
        'source': 'x',
      })!;
      expect(c.series.map((s) => s.name), ['ok']);
      expect(ChartData.parse({'labels': [], 'series': []}), isNull);
    });

    test('says where the numbers came from', () {
      expect(ChartData.parse(_bar())!.sourceLine, 'Computed by Qline from your data');
      expect(ChartData.parse(_bar(computed: false))!.sourceLine, 'From: Sheet: Sales 2026, tab Q3 · provided by the AI');
    });

    test('formats numbers compactly', () {
      expect(fmtNum(12), '12');
      expect(fmtNum(12500), '12.5k');
      expect(fmtNum(2000000), '2M');
      expect(fmtNum(1.25), '1.25');
    });
  });

  group('chat chart widget', () {
    testWidgets('shows title, source and a screen-reader summary with the values', (t) async {
      final handle = t.ensureSemantics();
      await t.pumpWidget(_wrap(ChatArtifact(_bar())));
      await t.pumpAndSettle();
      expect(find.text('Leads by source'), findsOneWidget);
      expect(find.text('Computed by Qline from your data'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Bar chart: Leads by source\. .*Web 12, Referral 5, Ads 3.*Computed by Qline')), findsOneWidget);
      handle.dispose();
    });

    testWidgets('AI-provided charts name their source', (t) async {
      await t.pumpWidget(_wrap(ChatArtifact(_bar(computed: false))));
      await t.pumpAndSettle();
      expect(find.text('From: Sheet: Sales 2026, tab Q3 · provided by the AI'), findsOneWidget);
    });

    testWidgets('pie charts list each slice with its share', (t) async {
      await t.pumpWidget(_wrap(const ChatChart({
        'chart': 'pie',
        'title': 'Tasks by status',
        'labels': ['Open', 'Done'],
        'series': [
          {'name': 'Tasks', 'values': [3, 1]},
        ],
        'source': 'Qline data',
        'computed': true,
      })));
      await t.pumpAndSettle();
      expect(find.text('Open · 3 (75%)'), findsOneWidget);
      expect(find.text('Done · 1 (25%)'), findsOneWidget);
    });

    testWidgets('grouped bars show a legend', (t) async {
      final d = _bar()
        ..['series'] = [
          {'name': 'This week', 'values': [1, 2, 3]},
          {'name': 'Last week', 'values': [3, 2, 1]},
        ];
      await t.pumpWidget(_wrap(ChatChart(d)));
      await t.pumpAndSettle();
      expect(find.text('This week'), findsOneWidget);
      expect(find.text('Last week'), findsOneWidget);
    });

    testWidgets('reduce motion draws the chart without animating', (t) async {
      await t.pumpWidget(_wrap(ChatChart(_bar()), reduceMotion: true));
      await t.pump();
      expect(t.hasRunningAnimations, isFalse);
    });

    testWidgets('a chart with no usable numbers says so instead of drawing nothing', (t) async {
      await t.pumpWidget(_wrap(const ChatChart({'chart': 'bar', 'title': 'Empty', 'labels': [], 'series': []})));
      await t.pumpAndSettle();
      expect(find.text('This chart had no usable numbers, so it is not shown.'), findsOneWidget);
    });
  });

  group('attachments', () {
    test('uploads right away and keeps the returned id', () async {
      final calls = <String>[];
      String? filename;
      final files = ChatAttachments(() => _api(calls, (r) async {
            filename = RegExp(r'filename="([^"]+)"').firstMatch(latin1.decode(r.bodyBytes))?.group(1);
            return _json({'id': '11111111-1111-4111-8111-111111111111', 'name': 'leads.csv', 'kind': 'records', 'note': 'Kept the first 500 rows.'}, 201);
          }));
      final note = await files.add((name: 'leads.csv', bytes: Uint8List.fromList(utf8.encode('name,email\nAna,a@x.co\n'))));
      expect(calls, ['POST /v1/agents/attachments']);
      expect(filename, 'leads.csv');
      expect(note, 'Kept the first 500 rows.');
      expect(files.items.single.id, '11111111-1111-4111-8111-111111111111');
      expect(files.items.single.kind, 'records');
      expect(files.uploading, isFalse);
      final sent = files.take();
      expect(sent.single.toMeta(), {'id': '11111111-1111-4111-8111-111111111111', 'name': 'leads.csv', 'kind': 'records', 'size': 21});
      expect(files.items, isEmpty);
      files.restore(sent);
      expect(files.items.length, 1, reason: 'a failed send puts the files back');
    });

    test('rejects oversized images before uploading', () async {
      final calls = <String>[];
      final files = ChatAttachments(() => _api(calls, (r) async => _json({})));
      await expectLater(files.add((name: 'big.png', bytes: Uint8List(chatImageMaxBytes + 1))), throwsA(isA<AttachmentTooLarge>()));
      expect(calls, isEmpty);
      expect(files.items, isEmpty);
    });

    test('a failed upload is removed from the tray', () async {
      final files = ChatAttachments(() => _api([], (r) async => _json({'error': {'code': 'UNSUPPORTED_FILE', 'message': 'That file type is not supported'}}, 415)));
      await expectLater(files.add((name: 'x.bin', bytes: Uint8List.fromList([1, 2, 3]))), throwsA(isA<ApiException>()));
      expect(files.items, isEmpty);
    });

    test('stops at five files', () async {
      var n = 0;
      final files = ChatAttachments(() => _api([], (r) async => _json({'id': 'id-${n++}', 'kind': 'document'}, 201)));
      for (var i = 0; i < maxChatAttachments; i++) {
        await files.add((name: 'n$i.txt', bytes: Uint8List.fromList([65])));
      }
      expect(files.full, isTrue);
      await expectLater(files.add((name: 'six.txt', bytes: Uint8List.fromList([65]))), throwsStateError);
    });

    testWidgets('pending chip can be removed and is labelled for screen readers', (t) async {
      final handle = t.ensureSemantics();
      var removed = false;
      await t.pumpWidget(_wrap(AttachmentChip(name: 'q3.xlsx', kind: 'records', size: 2048, onRemove: () => removed = true)));
      expect(find.bySemanticsLabel('Attached: q3.xlsx, 2 KB'), findsOneWidget);
      await t.tap(find.byTooltip('Remove q3.xlsx'));
      expect(removed, isTrue);
      handle.dispose();
    });
  });

  group('chat images', () {
    setUp(ChatImage.clearCache);

    testWidgets('loads the image with the session and shows its caption', (t) async {
      final calls = <String>[];
      final api = _api(calls, (r) async => http.Response.bytes(_png, 200, headers: {'content-type': 'image/png'}));
      await t.pumpWidget(_wrap(const ChatArtifact({'type': 'image', 'fileId': 'f1', 'name': 'receipt.png', 'caption': 'March receipt'}), api: api));
      await t.pumpAndSettle();
      expect(calls, ['GET /v1/files/f1/content']);
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('March receipt'), findsOneWidget);
    });

    testWidgets('shows a retry when the image cannot be loaded', (t) async {
      final api = _api([], (r) async => _json({'error': {'code': 'NOT_FOUND', 'message': 'Not found'}}, 404));
      await t.pumpWidget(_wrap(const ChatImage(fileId: 'gone', name: 'old.png'), api: api));
      await t.pumpAndSettle();
      expect(find.text('Could not load old.png'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });
}
