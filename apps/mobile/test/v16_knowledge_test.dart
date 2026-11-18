import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/integrations.dart';
import 'package:qline/screens/knowledge.dart';
import 'package:qline/screens/knowledge_graph.dart';
import 'package:qline/ui/theme.dart';

/// v1.6 run 3: Knowledge OS screens, the knowledge map and the Stripe key sheet.

Api _api(List<String> calls, Future<http.Response> Function(http.Request r) reply) => Api(
      client: MockClient((r) async {
        calls.add('${r.method} ${r.url.path}${r.url.query.isEmpty ? '' : '?${r.url.query}'}');
        return reply(r);
      }),
    );

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Member extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', orgs: [Org('o1', 'Shop', 'member')], orgId: 'o1');
}

Widget _wrap(Widget child, {required Api api, bool dark = false}) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(api), sessionProvider.overrideWith(_Member.new)],
      child: MaterialApp(theme: buildTheme(dark), home: MediaQuery(data: const MediaQueryData(size: Size(390, 844)), child: child)),
    );

const _cat = 'c0000000-0000-0000-0000-000000000001';
const _e1 = 'e0000000-0000-0000-0000-000000000001';
const _e2 = 'e0000000-0000-0000-0000-000000000002';
const _p1 = 'f0000000-0000-0000-0000-000000000001';

List<GNode> _nodes(int n) => [
      const GNode(id: 'category:$_cat', type: 'category', label: 'How we work', weight: 3),
      for (var i = 0; i < n; i++) GNode(id: 'entry:e$i', type: 'entry', label: 'Entry $i', category: _cat),
      const GNode(id: 'contact:$_p1', type: 'contact', label: 'Ana Reyes'),
    ];

void main() {
  group('graph layout', () {
    test('is deterministic, finite and stays inside the canvas', () {
      final nodes = _nodes(40);
      final edges = [for (var i = 0; i < 40; i++) GEdge('entry:e$i', 'category:$_cat', 'in'), const GEdge('entry:e3', 'contact:$_p1', 'about', aiAdded: true)];
      final a = layoutGraph(nodes, edges, size: 1000);
      final b = layoutGraph(nodes, edges, size: 1000);
      expect(a.length, nodes.length);
      for (final id in a.keys) {
        expect(a[id], b[id], reason: id);
        expect(a[id]!.dx.isFinite && a[id]!.dy.isFinite, isTrue);
        expect(a[id]!.dx, inInclusiveRange(24, 976));
        expect(a[id]!.dy, inInclusiveRange(24, 976));
      }
    });

    test('spreads nodes apart and keeps the focus in the centre', () {
      final nodes = _nodes(20);
      final pos = layoutGraph(nodes, const [], size: 1000, focus: 'contact:$_p1');
      expect(pos['contact:$_p1'], const Offset(500, 500));
      var minD = double.infinity;
      final p = pos.values.toList();
      for (var i = 0; i < p.length; i++) {
        for (var j = i + 1; j < p.length; j++) {
          minD = (p[i] - p[j]).distance < minD ? (p[i] - p[j]).distance : minD;
        }
      }
      expect(minD, greaterThan(12));
    });

    test('stable hash does not depend on the platform', () {
      expect(stableHash('entry:abc'), stableHash('entry:abc'));
      expect(stableHash(''), 0x811c9dc5);
      expect(stableHash('a') != stableHash('b'), isTrue);
    });

    test('handles the API caps (150 nodes) quickly', () {
      final nodes = _nodes(148);
      final sw = Stopwatch()..start();
      final pos = layoutGraph(nodes, [for (var i = 0; i < 148; i++) GEdge('entry:e$i', 'category:$_cat', 'in')]);
      expect(pos.length, 150);
      expect(sw.elapsedMilliseconds, lessThan(5000));
    });
  });

  group('knowledge screens', () {
    final graph = {
      'view': 'overview',
      'truncated': false,
      'nodes': [
        {'id': 'category:$_cat', 'type': 'category', 'label': 'How we work', 'weight': 2},
        {'id': 'entry:$_e1', 'type': 'entry', 'label': 'Delivery days', 'category': 'How we work', 'kind': 'process', 'visibility': 'workspace', 'status': 'active', 'weight': 1},
        {'id': 'entry:$_e2', 'type': 'entry', 'label': 'Supplier discount', 'kind': 'fact', 'visibility': 'private', 'status': 'proposed', 'weight': 1},
        {'id': 'contact:$_p1', 'type': 'contact', 'label': 'Ana Reyes', 'weight': 1},
      ],
      'edges': [
        {'from': 'entry:$_e1', 'to': 'category:$_cat', 'relation': 'in'},
        {'from': 'entry:$_e1', 'to': 'contact:$_p1', 'relation': 'about', 'aiAdded': true},
      ],
    };

    for (final dark in [false, true]) {
      testWidgets('map renders and the list view names every item (${dark ? 'dark' : 'light'})', (t) async {
        final calls = <String>[];
        await t.pumpWidget(_wrap(const KnowledgeGraphScreen(), api: _api(calls, (_) async => _json(graph)), dark: dark));
        await t.pumpAndSettle();
        expect(calls.single, contains('/v1/knowledge/graph?view=overview'));
        expect(find.byType(CustomPaint), findsWidgets);
        expect(find.text('Dashed: added by AI'), findsOneWidget);
        await t.tap(find.byTooltip('Show as list'));
        await t.pumpAndSettle();
        expect(find.text('Delivery days'), findsOneWidget);
        expect(find.text('Ana Reyes'), findsOneWidget);
        expect(find.textContaining('Private'), findsWidgets);
        expect(find.textContaining('Is about Ana Reyes'), findsOneWidget);
        expect(t.takeException(), isNull);
      });
    }

    testWidgets('tapping an item opens the inspector; "Center here" loads the ego view', (t) async {
      final calls = <String>[];
      await t.pumpWidget(_wrap(const KnowledgeGraphScreen(), api: _api(calls, (_) async => _json(graph))));
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Show as list'));
      await t.pumpAndSettle();
      await t.tap(find.text('Ana Reyes'));
      await t.pumpAndSettle();
      expect(find.text('Center here'), findsOneWidget);
      await t.tap(find.text('Center here'));
      await t.pumpAndSettle();
      expect(calls.last, contains('view=ego'));
      expect(Uri.decodeQueryComponent(calls.last), contains('focus=contact:$_p1'));
      expect(find.text('Around one item'), findsOneWidget);
    });

    testWidgets('entry screen shows privacy, AI-added links and history; share asks first', (t) async {
      final calls = <String>[];
      final entry = {
        'id': _e2,
        'title': 'Supplier discount',
        'body': '12% off above 50 kg.',
        'kind': 'fact',
        'category': 'Customers',
        'visibility': 'private',
        'status': 'proposed',
        'mine': true,
        'revision': 1,
        'source_kind': 'agent_inferred',
        'links': [
          {'id': 'l1', 'direction': 'out', 'type': 'contact', 'targetId': _p1, 'relation': 'about', 'aiAdded': true, 'title': 'Ana Reyes'},
        ],
        'revisions': [
          {'revision': 1, 'change_kind': 'create', 'changed_by': 'agent:x', 'changed_at': DateTime.now().toIso8601String()},
        ],
      };
      await t.pumpWidget(_wrap(const KnowledgeEntryScreen(id: _e2), api: _api(calls, (r) async => _json(r.method == 'POST' ? {...entry, 'visibility': 'workspace'} : entry))));
      await t.pumpAndSettle();
      expect(find.text('Private'), findsOneWidget);
      expect(find.text('Proposed'), findsOneWidget);
      expect(find.textContaining('Added by AI'), findsOneWidget);
      expect(find.textContaining('by an agent'), findsOneWidget);
      await t.ensureVisible(find.text('Share with workspace'));
      await t.tap(find.text('Share with workspace'));
      await t.pumpAndSettle();
      expect(find.text('Share this entry?'), findsOneWidget);
      await t.tap(find.text('Share'));
      await t.pumpAndSettle();
      expect(calls.any((c) => c == 'POST /v1/knowledge/entries/$_e2/share'), isTrue);
    });

    testWidgets('editor sends the revision it started from', (t) async {
      final calls = <String>[];
      Map<String, dynamic>? sent;
      await t.pumpWidget(_wrap(
        Builder(builder: (c) => Scaffold(body: Center(child: TextButton(onPressed: () => Navigator.of(c).push(MaterialPageRoute(builder: (_) => const KnowledgeEditor(entry: {'id': _e1, 'title': 'Delivery days', 'body': 'Tue', 'kind': 'process', 'revision': 3, 'visibility': 'workspace'}))), child: const Text('open'))))),
        api: _api(calls, (r) async {
          if (r.method == 'PATCH') sent = jsonDecode(r.body) as Map<String, dynamic>;
          return _json(r.url.path.endsWith('/categories') ? {'items': []} : {'id': _e1});
        }),
      ));
      await t.tap(find.text('open'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Tue'), 'Tue and Fri');
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();
      expect(sent, isNotNull);
      expect(sent!['ifRevision'], 3);
      expect(sent!['body'], 'Tue and Fri');
      expect(sent!.containsKey('visibility'), isFalse);
    });
  });

  group('stripe key sheet', () {
    testWidgets('refuses full secret keys before calling the API', (t) async {
      final calls = <String>[];
      await t.pumpWidget(_wrap(const Scaffold(body: StripeKeySheet()), api: _api(calls, (_) async => _json({}))));
      await t.enterText(find.byType(TextField), 'sk_live_123456789012');
      await t.tap(find.text('Connect Stripe').last);
      await t.pumpAndSettle();
      expect(find.textContaining('full secret key'), findsOneWidget);
      expect(calls, isEmpty);
      await t.enterText(find.byType(TextField), 'rk_test_123456789012');
      await t.tap(find.text('Connect Stripe').last);
      await t.pumpAndSettle();
      expect(calls, ['POST /v1/integrations/stripe/key']);
    });
  });
}
