import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/approvals.dart';
import 'package:qline/screens/operations.dart';
import 'package:qline/ui/theme.dart';
import 'package:qline/ui/widgets.dart';

/// M5 Ops UI: every control maps to a real API call, and controls appear only when the server says they are allowed.
typedef Sent = List<String>;

Api mockApi(Sent sent, Object? Function(http.Request r) reply) => Api(
      client: MockClient((r) async {
        sent.add('${r.method} ${r.url.path}${r.body.isNotEmpty && r.method != 'GET' ? ' ${r.body}' : ''}');
        final body = reply(r);
        if (body is http.Response) return body;
        return http.Response(jsonEncode(body ?? {}), 200, headers: {'content-type': 'application/json'});
      }),
    );

Widget app(Api api, Widget home, {bool light = false, double textScale = 1}) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(api)],
      child: MaterialApp(
        theme: buildTheme(light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: home,
      ),
    );

Map<String, dynamic> run({String status = 'needs_attention', Map? attention, bool canResolve = true, bool canCancel = true, List jobs = const []}) => {
      'id': 'r1',
      'status': status,
      'dry_run': false,
      'started_at': DateTime.now().toUtc().toIso8601String(),
      'error': null,
      'workflow': {'id': 'w1', 'name': 'Urgent lead alert'},
      'steps': [
        {'step_index': 0, 'kind': 'approval', 'status': 'succeeded', 'summary': 'Approved'},
      ],
      'approvals': [
        {'id': 'a1', 'status': 'approved', 'title': 'Post to Slack?', 'created_at': DateTime.now().toUtc().toIso8601String(), 'decided_at': DateTime.now().toUtc().toIso8601String()},
      ],
      'actions': [
        {'id': 't1', 'tool': 'slack.post', 'status': 'unknown', 'step_index': 1, 'result_summary': 'Outcome unknown after an interrupted attempt'},
      ],
      'jobs': jobs,
      'attention': attention,
      'permissions': {'canCancel': canCancel, 'canResolve': canResolve},
    };

void main() {
  testWidgets('approval and background-job filters stay usable at narrow widths and 200% text', (t) async {
    await t.binding.setSurfaceSize(const Size(320, 800));
    addTearDown(() => t.binding.setSurfaceSize(null));
    final api = mockApi([], (_) => {'items': []});

    await t.pumpWidget(app(api, const JobsScreen(), textScale: 2));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.ancestor(of: find.byType(SegmentedButton<String>), matching: find.byType(SingleChildScrollView)), findsOneWidget);

    await t.pumpWidget(app(api, const ApprovalsScreen(), textScale: 2));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.ancestor(of: find.byType(SegmentedButton<String>), matching: find.byType(SingleChildScrollView)), findsOneWidget);
  });

  testWidgets('status pill covers every runtime state with a word and an icon', (t) async {
    const states = ['queued', 'running', 'waiting_approval', 'needs_attention', 'completed', 'succeeded', 'failed', 'dead', 'cancelled', 'unknown', 'executing', 'skipped'];
    await t.pumpWidget(MaterialApp(theme: buildTheme(false), home: Scaffold(body: Wrap(children: [for (final s in states) StatusPill(s)]))));
    expect(find.text('Needs a check'), findsOneWidget);
    expect(find.text('Outcome unknown'), findsOneWidget);
    expect(find.text('Dead'), findsOneWidget);
    expect(find.text('Waiting approval'), findsOneWidget);
    expect(find.byType(Icon), findsNWidgets(states.length));
  });

  testWidgets('unknown outcome: no blind retry; "It went out" posts resolve=happened', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => r.url.path.endsWith('/resolve') ? {'id': 'r1', 'status': 'running'} : run(attention: {'kind': 'unknown_outcome', 'step': 1, 'tool': 'slack.post'}));
    await t.pumpWidget(app(api, const WorkflowRunDetail(id: 'r1')));
    await t.pumpAndSettle();
    expect(find.text('Check step 2 before it continues'), findsOneWidget);
    expect(find.textContaining('Qline will not resend it on its own'), findsOneWidget);
    expect(find.textContaining('Retry from'), findsNothing);
    await t.tap(find.text('It went out'));
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/workflow-runs/r1/resolve {"outcome":"happened"}'));
  });

  testWidgets('"send again" needs a confirmation before it posts', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => run(attention: {'kind': 'unknown_outcome', 'step': 1, 'tool': 'slack.post'}));
    await t.pumpWidget(app(api, const WorkflowRunDetail(id: 'r1')));
    await t.pumpAndSettle();
    await t.tap(find.text('It did not, send again'));
    await t.pumpAndSettle();
    expect(find.text('Send it again?'), findsOneWidget);
    await t.tap(find.text('Cancel').last);
    await t.pumpAndSettle();
    expect(sent.where((s) => s.contains('/resolve')), isEmpty);
    await t.tap(find.text('It did not, send again'));
    await t.pumpAndSettle();
    await t.tap(find.text('Send again'));
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/workflow-runs/r1/resolve {"outcome":"not_happened"}'));
  });

  testWidgets('a stopped run offers a safe retry from its step', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => run(attention: {'kind': 'stopped', 'step': 0}));
    await t.pumpWidget(app(api, const WorkflowRunDetail(id: 'r1')));
    await t.pumpAndSettle();
    expect(find.textContaining('Retrying is safe'), findsOneWidget);
    await t.tap(find.text('Retry from step 1'));
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/workflow-runs/r1/resolve {"outcome":"retry"}'));
  });

  testWidgets('without permission there are no controls, only an explanation', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => run(attention: {'kind': 'unknown_outcome', 'step': 1, 'tool': 'slack.post'}, canResolve: false, canCancel: false));
    await t.pumpWidget(app(api, const WorkflowRunDetail(id: 'r1')));
    await t.pumpAndSettle();
    expect(find.text('An owner, admin or manager can resolve this.'), findsOneWidget);
    expect(find.text('It went out'), findsNothing);
    expect(find.text('Cancel run'), findsNothing);
  });

  testWidgets('cancel run asks first, then posts cancel', (t) async {
    final sent = <String>[];
    final api = mockApi(sent, (r) => r.url.path.endsWith('/cancel') ? {'id': 'r1', 'status': 'cancelled'} : run(status: 'waiting_approval'));
    await t.pumpWidget(app(api, const WorkflowRunDetail(id: 'r1')));
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.text('Cancel run'), 200);
    await t.tap(find.text('Cancel run'));
    await t.pumpAndSettle();
    expect(find.text('Cancel this run?'), findsOneWidget);
    await t.tap(find.text('Cancel run').last);
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/workflow-runs/r1/cancel {}'));
  });

  testWidgets('jobs: unsafe retries have no Retry button; safe ones post retry', (t) async {
    final sent = <String>[];
    final jobs = [
      {'id': 'j1', 'kind': 'workflow.advance', 'status': 'dead', 'attempts': 3, 'max_attempts': 3, 'last_error': 'boom', 'run_id': 'r1', 'retry_safe': false, 'retry_note': 'An external action may or may not have happened.', 'created_at': '2026-11-17T00:00:00Z'},
      {'id': 'j2', 'kind': 'integration.sync', 'status': 'failed', 'attempts': 1, 'max_attempts': 1, 'last_error': 'token expired', 'run_id': null, 'retry_safe': true, 'retry_note': 'Safe to retry.', 'created_at': '2026-11-17T00:00:00Z'},
    ];
    final api = mockApi(sent, (r) => r.url.path.endsWith('/retry') ? {'id': 'j2', 'status': 'queued'} : {'items': jobs});
    await t.pumpWidget(app(api, const JobsScreen()));
    await t.pumpAndSettle();
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Open run'), findsOneWidget);
    expect(find.textContaining('may or may not have happened'), findsOneWidget);
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();
    expect(sent, contains('POST /v1/jobs/j2/retry {}'));
    expect(sent.where((s) => s.contains('/jobs/j1/retry')), isEmpty);
  });

  testWidgets('runs: empty state', (t) async {
    final api = mockApi([], (r) => {'items': [], 'counts': {}});
    await t.pumpWidget(app(api, const RunsScreen()));
    await t.pumpAndSettle();
    expect(find.text('Nothing needs you'), findsOneWidget);
  });

  testWidgets('runs: offline shows an offline state with a retry', (t) async {
    final offline = Api(client: MockClient((r) async => throw http.ClientException('no network')));
    await t.pumpWidget(app(offline, const RunsScreen(initialView: 'failed')));
    await t.pumpAndSettle();
    expect(find.text("You're offline"), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('runs list shows what each run needs', (t) async {
    final now = DateTime.now().toUtc().toIso8601String();
    final api = mockApi([], (r) => {
          'items': [
            {'id': 'r1', 'workflow_name': 'Morning briefing', 'status': 'waiting_approval', 'trigger_kind': 'schedule', 'started_at': now},
            {'id': 'r2', 'workflow_name': 'Urgent lead alert', 'status': 'needs_attention', 'trigger_kind': 'event', 'started_at': now, 'outcome_unknown': true},
          ],
          'counts': {},
        });
    await t.pumpWidget(app(api, const RunsScreen()));
    await t.pumpAndSettle();
    expect(find.text('Waiting for approval'), findsOneWidget);
    expect(find.text('An action may or may not have happened'), findsOneWidget);
  });

  test('every run state has a plain-language line', () {
    for (final s in ['queued', 'running', 'waiting_approval', 'needs_attention', 'completed', 'failed', 'rejected', 'cancelled']) {
      expect(runStateLine(s).endsWith('.'), isTrue, reason: s);
    }
  });
}
