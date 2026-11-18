import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/back_exit.dart';
import 'package:qline/core/chat_resume.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/knowledge_graph.dart';
import 'package:qline/screens/live.dart';
import 'package:qline/screens/shell.dart';
import 'package:qline/ui/activity_trace.dart';
import 'package:qline/ui/theme.dart';

/// Run 3 (docs/19): collapsed activity trace, knowledge in the chat, the map canvas, Android Back.

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Signed extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'ana@shop.ph', orgs: [Org('o1', 'Shop', 'owner')], orgId: 'o1');
}

class _MemPositions implements GraphPositionStore {
  final values = <String, Map<String, Offset>>{};
  @override
  Future<void> clear(String key) async => values.remove(key);
  @override
  Future<Map<String, Offset>> read(String key) async => values[key] ?? {};
  @override
  Future<void> write(String key, Map<String, Offset> pos) async => values[key] = {...pos};
}

const _e1 = 'e0000000-0000-0000-0000-000000000001';
final _graph = {
  'truncated': false,
  'nodes': [
    {'id': 'category:c1', 'type': 'category', 'label': 'How we work', 'weight': 2},
    {'id': 'entry:$_e1', 'type': 'entry', 'label': 'Delivery days', 'category': 'c1', 'kind': 'process', 'visibility': 'workspace', 'status': 'active'},
    {'id': 'contact:p1', 'type': 'contact', 'label': 'Ana Reyes'},
    {'id': 'project:j1', 'type': 'project', 'label': 'Lonely project'},
  ],
  'edges': [
    {'from': 'entry:$_e1', 'to': 'category:c1', 'relation': 'in'},
    {'from': 'entry:$_e1', 'to': 'contact:p1', 'relation': 'about'},
  ],
};

Widget _app(Widget child, {required http.Client client, _MemPositions? positions}) => ProviderScope(
  overrides: [
    apiProvider.overrideWithValue(Api(client: client)),
    sessionProvider.overrideWith(_Signed.new),
    chatPointerStoreProvider.overrideWithValue(MemoryChatPointerStore()),
    graphPositionStoreProvider.overrideWithValue(positions ?? _MemPositions()),
  ],
  child: MaterialApp(
    theme: buildTheme(false),
    home: MediaQuery(
      data: const MediaQueryData(size: Size(390, 844)),
      child: child,
    ),
  ),
);

String _sse(List<(String, Map<String, dynamic>)> events) => [for (var i = 0; i < events.length; i++) 'id: $i\nevent: ${events[i].$1}\ndata: ${jsonEncode(events[i].$2)}\n\n'].join();

/// The chat core and loading skeletons animate forever, so pumpAndSettle never settles there.
Future<void> _settle(WidgetTester t) async {
  for (var i = 0; i < 12; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

/// A phone-sized window (the default test window is 800×600).
void _phone(WidgetTester t) {
  t.view.physicalSize = const Size(390, 844);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
}

void main() {
  group('activity trace', () {
    Widget host(Widget w) => _app(
      Scaffold(
        body: Padding(padding: const EdgeInsets.all(16), child: w),
      ),
      client: MockClient((_) async => _json({})),
    );
    TraceStep done(String tool, String label, {String risk = 'L0'}) => TraceStep(tool: tool, running: label.replaceFirst('Checked', 'Checking'), done: label, risk: risk)..ok = true;

    testWidgets('reads fold into one line; tool names only appear as a detail when opened', (t) async {
      await t.pumpWidget(host(ActivityTrace(steps: [done('tasks.search', 'Checked your tasks'), done('contacts.search', 'Checked your contacts')])));
      expect(find.text('Checked your contacts'), findsOneWidget);
      expect(find.text(' · 2 steps'), findsOneWidget);
      expect(find.text('Checked your tasks'), findsNothing);
      expect(find.textContaining('tasks.search'), findsNothing);
      await t.tap(find.text('Checked your contacts'));
      await t.pumpAndSettle();
      expect(find.text('Checked your tasks'), findsOneWidget);
      expect(find.textContaining('tasks.search'), findsOneWidget);
    });

    testWidgets('approvals, failures, changes and unknown outcomes stay visible while collapsed', (t) async {
      var opened = 0;
      final waiting = TraceStep(tool: 'slack.post', running: 'Post to Slack', done: 'Post to Slack', risk: 'L2', decision: 'require_approval');
      final unknown = TraceStep(tool: 'gmail.send', running: 'Send email', done: 'Send email', risk: 'L3')
        ..ok = false
        ..outcome = 'unknown';
      final created = TraceStep(tool: 'tasks.create', running: 'Create task', done: 'Create task', risk: 'L1')..ok = true;
      await t.pumpWidget(host(ActivityTrace(steps: [done('tasks.search', 'Checked your tasks'), created, waiting, unknown], onAttention: () => opened++)));
      expect(find.text('Post to Slack'), findsOneWidget);
      expect(find.text('Waiting for approval'), findsOneWidget);
      expect(find.text('Create task'), findsOneWidget);
      expect(find.text('Needs attention · tap to check'), findsOneWidget);
      await t.tap(find.text('Needs attention · tap to check'));
      expect(opened, 1);
    });

    testWidgets('an answer from history loads its steps when opened', (t) async {
      final calls = <String>[];
      await t.pumpWidget(
        _app(
          const Scaffold(
            body: ActivityTrace(steps: [], runId: 'r1'),
          ),
          client: MockClient((r) async {
            calls.add(r.url.path);
            return _json({
              'toolCalls': [
                {
                  'id': 's1',
                  'tool': 'tasks.search',
                  'status': 'succeeded',
                  'risk': 'L0',
                  'result_summary': '3 open tasks',
                  'running': 'Checking your tasks',
                  'done': 'Checked your tasks',
                  'created_at': '2026-11-19T01:00:00Z',
                  'finished_at': '2026-11-19T01:00:02Z',
                },
              ],
            });
          }),
        ),
      );
      expect(calls, isEmpty);
      await t.tap(find.text('What Qline did'));
      await t.pumpAndSettle();
      expect(calls, ['/v1/runs/r1']);
      expect(find.text('Checked your tasks'), findsWidgets);
      expect(find.text('3 open tasks'), findsOneWidget);
      expect(find.textContaining('2 s'), findsOneWidget);
    });
  });

  group('knowledge in the chat', () {
    setUp(() {
      FlutterSecureStorage.setMockInitialValues({});
      // Sending stops any voice playback first; these plugins have no implementation in tests.
      for (final ch in ['xyz.luan/audioplayers', 'xyz.luan/audioplayers.global', 'xyz.luan/audioplayers.global/events', 'flutter_tts', 'plugin.csdcorp.com/speech_to_text', 'wakelock_plus']) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (_) async => null);
      }
    });
    testWidgets('the toggle sits left of the composer, opens the map over the chat and adds an entry as context', (t) async {
      Map<String, dynamic>? sent;
      final client = MockClient.streaming((r, body) async {
        final p = r.url.path;
        http.StreamedResponse ok(Object o) => http.StreamedResponse(Stream.value(utf8.encode(jsonEncode(o))), 200, headers: {'content-type': 'application/json'});
        if (p.endsWith('/agents')) {
          return ok({
            'items': [
              {'id': 'a1', 'template': 'ceo', 'name': 'CEO'},
            ],
          });
        }
        if (p.endsWith('/ai/overview')) {
          return ok({
            'status': 'ok',
            'agents': [
              {'id': 'a1', 'ready': true},
            ],
          });
        }
        if (p.endsWith('/conversations') && r.method == 'GET') return ok({'items': []});
        if (p.endsWith('/conversations') && r.method == 'POST') return ok({'id': 'c9'});
        if (p.endsWith('/knowledge/graph')) return ok(_graph);
        if (p.endsWith('/conversations/c9/messages')) {
          sent = jsonDecode(await body.bytesToString()) as Map<String, dynamic>;
          return ok({'runId': 'r9'});
        }
        if (p.endsWith('/runs/r9/stream')) {
          final text = _sse([
            (
              'tool.planned',
              {
                'stepId': 's1',
                'tool': 'knowledge.search',
                'summary': 'Search knowledge',
                'decision': 'allow',
                'running': 'Checking your knowledge base',
                'done': 'Checked your knowledge base',
                'risk': 'L0',
              },
            ),
            ('tool.result', {'stepId': 's1', 'ok': true, 'summary': '1 entry'}),
            ('token', {'text': 'We deliver on **Tuesdays**.'}),
            ('done', {'status': 'completed'}),
          ]);
          return http.StreamedResponse(Stream.value(utf8.encode(text)), 200, headers: {'content-type': 'text/event-stream'});
        }
        return ok({});
      });
      _phone(t);
      await t.pumpWidget(_app(const LiveScreen(), client: client));
      await t.pump();
      await t.pump(const Duration(milliseconds: 50));
      final toggle = find.byTooltip('Add knowledge');
      expect(toggle, findsOneWidget);
      expect(t.getTopLeft(toggle).dx, lessThan(t.getTopLeft(find.byType(TextField)).dx));

      await t.tap(toggle);
      await _settle(t);
      expect(find.text('Knowledge'), findsOneWidget);
      await t.tap(find.byTooltip('Show as list'));
      await _settle(t);
      await t.tap(find.text('Delivery days'));
      await _settle(t);
      await t.tap(find.text('Add to chat'));
      await _settle(t);
      expect(find.text('Knowledge'), findsNothing); // back in the chat
      expect(find.widgetWithText(InputChip, 'Delivery days'), findsOneWidget);

      await t.enterText(find.byType(TextField), 'When do we deliver?');
      await t.tap(find.byTooltip('Send'));
      // Stopping the voice player goes through platform channels: give them real time.
      for (var i = 0; i < 5; i++) {
        await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await t.pump(const Duration(milliseconds: 100));
      }
      await _settle(t);
      expect(sent!['knowledge'], [_e1]);
      expect(find.widgetWithText(InputChip, 'Delivery days'), findsNothing); // used once, then cleared
      expect(find.bySemanticsLabel('Using knowledge: Delivery days'), findsOneWidget);
      expect(find.text('Checked your knowledge base'), findsOneWidget);
      final shown = t.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText()).join('\n');
      expect(shown, contains('We deliver on Tuesdays.'));
      expect(shown.contains('**'), isFalse);
      expect(find.textContaining('knowledge.search'), findsNothing);
    });

    testWidgets('a chosen entry can be removed before sending', (t) async {
      final client = MockClient((r) async => r.url.path.endsWith('/knowledge/graph') ? _json(_graph) : _json({'items': []}));
      _phone(t);
      await t.pumpWidget(_app(const LiveScreen(), client: client));
      await t.pump(const Duration(milliseconds: 50));
      await t.tap(find.byTooltip('Add knowledge'));
      await _settle(t);
      await t.tap(find.byTooltip('Show as list'));
      await _settle(t);
      await t.tap(find.text('Delivery days'));
      await _settle(t);
      await t.tap(find.text('Add to chat'));
      await _settle(t);
      await t.tap(find.byTooltip('Remove Delivery days'));
      await _settle(t);
      expect(find.widgetWithText(InputChip, 'Delivery days'), findsNothing);
    });
  });

  group('knowledge canvas', () {
    Future<_MemPositions> open(WidgetTester t) async {
      final pos = _MemPositions();
      await t.pumpWidget(
        _app(
          KnowledgeGraphScreen(key: UniqueKey()),
          client: MockClient((_) async => _json(_graph)),
          positions: pos,
        ),
      );
      await t.pumpAndSettle();
      return pos;
    }

    testWidgets('zoom, fit and reset controls work and are labelled', (t) async {
      final pos = await open(t);
      final viewer = t.widget<InteractiveViewer>(find.byType(InteractiveViewer));
      final before = viewer.transformationController!.value.getMaxScaleOnAxis();
      await t.tap(find.byTooltip('Zoom in'));
      await t.pumpAndSettle();
      expect(viewer.transformationController!.value.getMaxScaleOnAxis(), greaterThan(before));
      await t.tap(find.byTooltip('Zoom out'));
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Zoom out'));
      await t.pumpAndSettle();
      expect(viewer.transformationController!.value.getMaxScaleOnAxis(), lessThan(before));
      await t.tap(find.byTooltip('Fit to screen'));
      await t.pumpAndSettle();
      expect(viewer.transformationController!.value.getMaxScaleOnAxis(), closeTo(before, before * .05));
      pos.values['qline.kgpos.o1.overview'] = {'entry:$_e1': const Offset(10, 10)};
      await t.tap(find.byTooltip('Reset layout'));
      await t.pumpAndSettle();
      expect(pos.values.containsKey('qline.kgpos.o1.overview'), isFalse);
      expect(viewer.boundaryMargin, const EdgeInsets.all(double.infinity));
    });

    testWidgets('filters and search narrow the map; "connected only" hides lonely items', (t) async {
      await open(t);
      await t.tap(find.byTooltip('Show as list'));
      await t.pumpAndSettle();
      expect(find.text('Lonely project'), findsOneWidget);
      await t.ensureVisible(find.text('Connected only'));
      await t.pumpAndSettle();
      await t.tap(find.text('Connected only'));
      await t.pumpAndSettle();
      expect(find.text('Lonely project'), findsNothing);
      expect(find.text('Ana Reyes'), findsOneWidget);
      await t.tap(find.text('Connected only'));
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('Contacts'));
      await t.pumpAndSettle();
      await t.tap(find.text('Contacts'));
      await t.pumpAndSettle();
      expect(find.text('Delivery days'), findsNothing);
      expect(find.text('Ana Reyes'), findsOneWidget);
      await t.ensureVisible(find.text('All'));
      await t.pumpAndSettle();
      await t.tap(find.text('All'));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), 'deliv');
      await t.pumpAndSettle();
      expect(find.text('1 match'), findsOneWidget);
      expect(find.text('Delivery days'), findsOneWidget);
      expect(find.text('Ana Reyes'), findsNothing);
    });

    test('saved positions override the layout and are capped', () {
      final f = filterGraph(
        [const GNode(id: 'a', type: 'entry', label: 'A'), const GNode(id: 'b', type: 'contact', label: 'B')],
        [const GEdge('a', 'b', 'about')],
        types: {'entry'},
      );
      expect(f.nodes.map((n) => n.id), ['a']);
      expect(f.edges, isEmpty);
      expect(searchGraph([const GNode(id: 'a', type: 'entry', label: 'Delivery days')], 'DAYS'), {'a'});
      expect(maxSavedPositions, lessThanOrEqualTo(300));
    });
  });

  group('Android Back', () {
    late int exits;
    setUp(() {
      exits = 0;
      exitApp = () async => exits++;
    });
    Future<void> shell(WidgetTester t) async {
      await t.pumpWidget(_app(const Shell(), client: MockClient((_) async => _json({'items': []}))));
      await t.pump(const Duration(milliseconds: 100));
    }

    testWidgets('on Home, Back asks once; Stay keeps the app open, Exit closes it', (t) async {
      await shell(t);
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Close Qline?'), findsOneWidget);
      // A second Back closes the question (= Stay); it never stacks a second dialog.
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Close Qline?'), findsNothing);
      expect(exits, 0);
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Close Qline?'), findsOneWidget);
      await t.tap(find.text('Stay'));
      await _settle(t);
      expect(exits, 0);
      await t.binding.handlePopRoute();
      await _settle(t);
      await t.tap(find.text('Exit'));
      await _settle(t);
      expect(exits, 1);
    });

    testWidgets('on another tab, Back goes Home first', (t) async {
      await shell(t);
      await t.tap(find.text('Work').last);
      await _settle(t);
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Close Qline?'), findsNothing);
      expect(find.text('Home'), findsWidgets);
    });

    testWidgets('on a nested screen, Back just goes back', (t) async {
      await shell(t);
      await t.tap(find.byTooltip('Search'));
      await _settle(t);
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Close Qline?'), findsNothing);
      expect(find.byType(Shell), findsOneWidget);
      expect(exits, 0);
    });

    testWidgets('leaving the chat with an unsent message asks first', (t) async {
      await t.pumpWidget(
        _app(
          Builder(
            builder: (c) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(c).push(MaterialPageRoute(builder: (_) => const LiveScreen())),
                child: const Text('open'),
              ),
            ),
          ),
          client: MockClient((_) async => _json({'items': []})),
        ),
      );
      await t.tap(find.text('open'));
      await _settle(t);
      await t.enterText(find.byType(TextField), 'half a thought');
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Leave the chat?'), findsOneWidget);
      await t.tap(find.text('Cancel'));
      await _settle(t);
      expect(find.byType(LiveScreen), findsOneWidget);
      await t.enterText(find.byType(TextField), '');
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.byType(LiveScreen), findsNothing);
    });
  });
}
