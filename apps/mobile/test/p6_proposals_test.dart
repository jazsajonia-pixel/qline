import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/missions.dart';
import 'package:qline/screens/proposals.dart';
import 'package:qline/ui/chat_artifacts.dart';
import 'package:qline/ui/theme.dart';

/// Phase 6 (docs/21, M8): AI proposals are reviewed in the app before anything changes.

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Signed extends SessionNotifier {
  _Signed(this.role);
  final String role;
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'ana@shop.ph', orgs: [Org('o1', 'Shop', role)], orgId: 'o1');
}

Widget _app(Widget child, http.Client client, {String role = 'owner'}) => ProviderScope(
  overrides: [apiProvider.overrideWithValue(Api(client: client)), sessionProvider.overrideWith(() => _Signed(role))],
  child: MaterialApp(theme: buildTheme(false), home: Scaffold(body: child)),
);

Future<void> _settle(WidgetTester t) async {
  for (var i = 0; i < 10; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

final _mission = {
  'id': 'p1',
  'kind': 'mission',
  'title': 'Win back lapsed customers',
  'status': 'proposed',
  'revision': 1,
  'created_at': DateTime.now().toUtc().toIso8601String(),
  'canApply': true,
  'payload': {
    'title': 'Win back lapsed customers',
    'purpose': 'Email customers who have not ordered in 90 days.',
    'constraints': ['No discounts above 10%'],
    'successCriteria': ['Drafts ready'],
    'agents': ['sales'],
    'budgetToolCalls': 30,
  },
};

void main() {
  testWidgets('Missions shows proposed missions; reviewing and approving calls apply with the revision', (t) async {
    final calls = <String>[];
    final client = MockClient((r) async {
      calls.add('${r.method} ${r.url.path} ${r.body}');
      if (r.url.path.endsWith('/missions')) return _json({'items': [], 'controls': {}});
      if (r.url.path.endsWith('/proposals')) return _json({'items': [_mission]});
      if (r.url.path.endsWith('/proposals/p1/apply')) return _json({..._mission, 'status': 'applied', 'applied_ref': 'mission:m1'});
      if (r.url.path.endsWith('/proposals/p1')) return _json(_mission);
      return _json({});
    });
    await t.pumpWidget(_app(const MissionsScreen(), client));
    await _settle(t);
    expect(find.text('PROPOSED MISSIONS'), findsOneWidget);
    expect(find.text('Win back lapsed customers'), findsOneWidget);
    expect(find.textContaining('Proposed by AI'), findsOneWidget);
    await t.tap(find.text('Win back lapsed customers'));
    await _settle(t);
    expect(find.text('Review proposal'), findsOneWidget);
    expect(find.text('• No discounts above 10%'), findsOneWidget);
    expect(find.textContaining('30 tool calls'), findsOneWidget);
    expect(find.textContaining('you approve that plan before any task runs'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Approve and create'), 200, scrollable: find.byType(Scrollable).last);
    await t.tap(find.text('Approve and create'));
    await _settle(t);
    expect(calls.any((c) => c.startsWith('POST /v1/proposals/p1/apply') && c.contains('"revision":1')), isTrue);
  });

  testWidgets('agent change shows before/after and flags sensitive tools; members cannot apply', (t) async {
    final change = {
      'id': 'p2',
      'kind': 'agent_change',
      'title': 'Change Sales',
      'status': 'proposed',
      'revision': 1,
      'created_at': DateTime.now().toUtc().toIso8601String(),
      'canApply': false,
      'payload': {'agentId': 'a1', 'instructions': 'Be brief.', 'reason': 'User asked'},
      'diff': {
        'agentName': 'Sales',
        'before': {'name': 'Sales', 'instructions': 'Be thorough.', 'tools': []},
        'after': {'name': 'Sales', 'instructions': 'Be brief.', 'tools': []},
        'added': ['contacts.update'],
        'removed': [],
        'sensitive': ['contacts.update'],
      },
    };
    final client = MockClient((r) async => _json(change));
    await t.pumpWidget(_app(const ProposalScreen(id: 'p2'), client, role: 'member'));
    await _settle(t);
    expect(find.text('Now: Be thorough.'), findsOneWidget);
    expect(find.text('After: Be brief.'), findsOneWidget);
    expect(find.textContaining('can change data or reach outside Qline'), findsOneWidget);
    expect(find.text('Only an owner or admin can apply this change.'), findsOneWidget);
    expect(find.text('Approve change'), findsNothing);
  });

  testWidgets('a proposal from chat renders as a card', (t) async {
    await t.pumpWidget(_app(const ChatArtifact({'type': 'proposal', 'id': 'p1', 'kind': 'mission', 'title': 'Price check'}), MockClient((_) async => _json({}))));
    await _settle(t);
    expect(find.text('Price check'), findsOneWidget);
    expect(find.text('Proposed mission · Tap to review'), findsOneWidget);
  });
}
