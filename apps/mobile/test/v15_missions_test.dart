import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/missions.dart';
import 'package:qline/ui/theme.dart';

/// v1.5 Missions UI: plan approval and controls map to real API calls; controls follow server permissions.
Api mockApi(List<String> sent, Object? Function(http.Request r) reply) => Api(
      client: MockClient((r) async {
        sent.add('${r.method} ${r.url.path}${r.body.isNotEmpty && r.method != 'GET' ? ' ${r.body}' : ''}');
        return http.Response(jsonEncode(reply(r) ?? {}), 200, headers: {'content-type': 'application/json'});
      }),
    );

Widget app(Api api, Widget home, {double textScale = 1}) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(api)],
      child: MaterialApp(
        theme: buildTheme(false),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
        home: home,
      ),
    );

final now = DateTime.now().toUtc().toIso8601String();
Map<String, dynamic> controls({bool stop = false, bool paused = false, bool canPause = true, bool canStop = true, bool canRelease = true}) =>
    {'workspaceId': 'ws1', 'paused': paused, 'emergencyStop': stop, 'maxParallelTasks': 3, 'canPause': canPause, 'canStop': canStop, 'canRelease': canRelease};

Map<String, dynamic> mission(String status, {List tasks = const []}) => {
      'id': 'm1',
      'goal': 'Grow renewals this month',
      'status': status,
      'created_at': now,
      'error': null,
      'spent_tokens': 1200,
      'budget_tokens': 200000,
      'spent_tool_calls': 1,
      'budget_tool_calls': 60,
      'result_review': 'pending',
      'plan': {
        'id': 'p1',
        'version': 1,
        'status': status == 'awaiting_plan_approval' ? 'proposed' : 'approved',
        'plan': {
          'summary': 'Find renewals, then draft follow-ups.',
          'tasks': [
            {'key': 'find', 'agent': 'research', 'title': 'Find renewals', 'instructions': 'Search contacts', 'dependsOn': [], 'review': 'schema'},
            {'key': 'draft', 'agent': 'sales', 'title': 'Draft follow-ups', 'instructions': 'Draft emails', 'dependsOn': ['find'], 'review': 'human'},
          ],
        },
      },
      'tasks': tasks,
    };

void main() {
  testWidgets('list shows controls from the server; emergency stop needs confirmation and calls PUT', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => r.method == 'GET' ? {'items': [mission('running')..['task_count'] = 2..['tasks_done'] = 1], 'controls': controls()} : controls(stop: true));
    await t.pumpWidget(app(api, const MissionsScreen()));
    await t.pumpAndSettle();
    expect(find.text('Missions can run'), findsOneWidget);
    expect(find.textContaining('1/2 tasks done'), findsOneWidget);
    await t.tap(find.text('Emergency stop'));
    await t.pumpAndSettle();
    await t.tap(find.text('Stop everything'));
    await t.pumpAndSettle();
    expect(sent, contains('PUT /v1/workspaces/ws1/controls {"emergencyStop":true}'));
  });

  testWidgets('members without permission see no control buttons; stopped state explains who can release', (t) async {
    final api = mockApi([], (r) => {'items': [], 'controls': controls(stop: true, canPause: false, canStop: false, canRelease: false)});
    await t.pumpWidget(app(api, const MissionsScreen()));
    await t.pumpAndSettle();
    expect(find.text('Emergency stop is on'), findsOneWidget);
    expect(find.text('Turn off emergency stop'), findsNothing);
    expect(find.text('Only an owner or admin can turn it off.'), findsOneWidget);
    expect(find.text('Pause'), findsNothing);
  });

  testWidgets('plan review: approve sends the plan version', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => mission('awaiting_plan_approval'));
    await t.pumpWidget(app(api, const MissionDetail(id: 'm1')));
    await t.pumpAndSettle();
    expect(find.text('1. Find renewals'), findsOneWidget);
    expect(find.textContaining('you review the output'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Approve plan'), 200);
    await t.tap(find.text('Approve plan'));
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/missions/m1/plan/decision {"decision":"approve","planVersion":1}'));
  });

  testWidgets('task in review: accept calls the review endpoint; large text does not overflow', (t) async {
    final sent = <String>[];
    final tasks = [
      {'id': 't1', 'key': 'find', 'agent': 'research', 'title': 'Find renewals', 'status': 'succeeded', 'output': {'summary': 'Three renewals'}, 'tool_calls': 1, 'tokens': 300},
      {'id': 't2', 'key': 'draft', 'agent': 'sales', 'title': 'Draft follow-ups', 'status': 'review', 'output': {'summary': 'Drafts ready'}, 'tool_calls': 0, 'tokens': 200},
    ];
    final api = mockApi(sent, (r) => mission('running', tasks: tasks));
    await t.pumpWidget(app(api, const MissionDetail(id: 'm1'), textScale: 1.3));
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.text('Accept'), 200, scrollable: find.byWidgetPredicate((w) => w is Scrollable && w.axisDirection == AxisDirection.down).first);
    await t.tap(find.text('Accept'));
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/mission-tasks/t2/review {"decision":"accept"}'));
    expect(t.takeException(), isNull);
  });

  testWidgets('an older server without missions shows a clear message, not an error', (t) async {
    final api = Api(client: MockClient((r) async => http.Response(jsonEncode({'code': 'NOT_FOUND', 'title': 'Not found', 'status': 404}), 404, headers: {'content-type': 'application/problem+json'})));
    await t.pumpWidget(app(api, const MissionsScreen()));
    await t.pumpAndSettle();
    expect(find.text('Missions are not on your server yet'), findsOneWidget);
  });
}
