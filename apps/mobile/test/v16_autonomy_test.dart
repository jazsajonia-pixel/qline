import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/core/voice.dart';
import 'package:qline/screens/autonomy.dart';
import 'package:qline/ui/theme.dart';

/// v1.6: autonomy settings map to the real API, and the voice speaks a short line, not the whole answer.
Api mockApi(List<String> sent, Object? Function(http.Request r) reply) => Api(
      client: MockClient((r) async {
        sent.add('${r.method} ${r.url.path}${r.body.isNotEmpty && r.method != 'GET' ? ' ${r.body}' : ''}');
        return http.Response(jsonEncode(reply(r) ?? {}), 200, headers: {'content-type': 'application/json'});
      }),
    );

Widget app(Api api, Widget home) => ProviderScope(overrides: [apiProvider.overrideWithValue(api)], child: MaterialApp(theme: buildTheme(false), home: home));

void main() {
  group('spoken line', () {
    test('uses the model speech when there is one', () {
      expect(spokenLine('You have three new leads.', '## Leads\n1. Ana\n2. Ben\n3. Cy'), 'You have three new leads.');
    });
    test('falls back to the first sentence or two, never the whole answer', () {
      final long = 'You have 12 open tasks. Four are overdue. Here is the list: ${List.filled(40, 'call the supplier').join(', ')}.';
      final s = spokenLine(null, long);
      expect(s, 'You have 12 open tasks. Four are overdue.');
      expect(spokenLine('', 'x' * 600).length, lessThanOrEqualTo(220));
    });
  });

  group('AI autonomy screen', () {
    testWidgets('shows the current level and changes it through the API', (t) async {
      final sent = <String>[];
      var level = 'supervised';
      final api = mockApi(sent, (r) {
        if (r.url.path.endsWith('/missions')) return {'items': [], 'controls': {'workspaceId': 'ws1'}};
        if (r.method == 'PUT') level = (jsonDecode(r.body) as Map)['autonomy'] as String;
        return {'autonomy': level, 'canChange': true, 'dailyExternalLimit': 25, 'externalToday': 0, 'externalCapReached': false};
      });
      await t.pumpWidget(app(api, const AutonomyScreen()));
      await t.pumpAndSettle();
      expect(find.text('Supervised'), findsOneWidget);
      expect(find.text('Autopilot'), findsOneWidget);
      expect(find.text('Full autopilot'), findsOneWidget);
      await t.tap(find.text('Autopilot'));
      await t.pumpAndSettle();
      expect(sent, contains('PUT /v1/workspaces/ws1/autonomy {"autonomy":"autopilot"}'));
    });

    testWidgets('full autopilot asks for confirmation first', (t) async {
      final sent = <String>[];
      final api = mockApi(sent, (r) {
        if (r.url.path.endsWith('/missions')) return {'items': [], 'controls': {'workspaceId': 'ws1'}};
        return {'autonomy': 'supervised', 'canChange': true, 'dailyExternalLimit': 25, 'externalToday': 0};
      });
      await t.pumpWidget(app(api, const AutonomyScreen()));
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('Full autopilot'));
      await t.tap(find.text('Full autopilot'));
      await t.pumpAndSettle();
      expect(find.text('Turn on full autopilot?'), findsOneWidget);
      expect(sent.where((s) => s.startsWith('PUT')), isEmpty);
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(sent.where((s) => s.startsWith('PUT')), isEmpty);
    });

    testWidgets('members see the level but cannot change it', (t) async {
      final sent = <String>[];
      final api = mockApi(sent, (r) {
        if (r.url.path.endsWith('/missions')) return {'items': [], 'controls': {'workspaceId': 'ws1'}};
        return {'autonomy': 'autopilot', 'canChange': false, 'dailyExternalLimit': 25};
      });
      await t.pumpWidget(app(api, const AutonomyScreen()));
      await t.pumpAndSettle();
      expect(find.text('Only an owner or admin can change this.'), findsOneWidget);
      await t.tap(find.text('Supervised'));
      await t.pumpAndSettle();
      expect(sent.where((s) => s.startsWith('PUT')), isEmpty);
    });
  });
}
