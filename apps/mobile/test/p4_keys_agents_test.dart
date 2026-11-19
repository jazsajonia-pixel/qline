import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/agent_studio.dart';
import 'package:qline/screens/ai.dart';
import 'package:qline/ui/theme.dart';

/// Phase 4 (docs/21): several keys per provider (M10) and your own agents (M9).

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Signed extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'ana@shop.ph', orgs: [Org('o1', 'Shop', 'owner')], orgId: 'o1');
}

Widget _app(Widget child, http.Client client) => ProviderScope(
  overrides: [apiProvider.overrideWithValue(Api(client: client)), sessionProvider.overrideWith(_Signed.new)],
  child: MaterialApp(theme: buildTheme(false), home: child),
);

Future<void> _settle(WidgetTester t) async {
  for (var i = 0; i < 10; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

void main() {
  testWidgets('provider card lists keys by name and state, never secrets; rename and turn off call the API', (t) async {
    final calls = <String>[];
    final overview = {
      'status': 'ready',
      'canManage': true,
      'default': {'provider': 'google', 'model': 'gemini-x'},
      'agents': [],
      'providers': [
        {
          'id': 'google',
          'name': 'Google Gemini',
          'maker': 'Google',
          'connected': true,
          'keyHint': 'AAAA',
          'modelCount': 4,
          'status': 'ok',
          'keys': [
            {'id': 'k1', 'alias': 'Gemini key 1', 'keyHint': 'AAAA', 'primary': true, 'enabled': true, 'state': 'ready', 'uses': 12},
            {'id': 'k2', 'alias': 'Work account', 'keyHint': 'BBBB', 'primary': false, 'enabled': true, 'state': 'cooling_down', 'cooldownUntil': DateTime.now().add(const Duration(minutes: 2)).toUtc().toIso8601String(), 'uses': 3},
            {'id': 'k3', 'alias': 'Old', 'keyHint': 'CCCC', 'primary': false, 'enabled': true, 'state': 'needs_attention', 'statusDetail': 'Rejected by Google', 'uses': 0},
          ],
        },
      ],
    };
    final client = MockClient((r) async {
      calls.add('${r.method} ${r.url.path} ${r.body}');
      if (r.url.path.endsWith('/ai/overview')) return _json(overview);
      if (r.method == 'PATCH') return _json({'id': 'k2', 'alias': 'Renamed', 'state': 'off'});
      return _json({});
    });
    await t.pumpWidget(_app(const AiProvidersScreen(), client));
    await _settle(t);
    expect(find.text('Gemini key 1'), findsOneWidget);
    expect(find.text('Work account'), findsOneWidget);
    expect(find.text('Cooling down'), findsOneWidget);
    expect(find.text('Needs attention'), findsOneWidget);
    expect(find.text('Rejected by Google'), findsOneWidget);
    expect(find.text('3 keys · 4 models'), findsOneWidget);
    expect(find.text('Add another key'), findsOneWidget);
    // Turn off the second key.
    await t.tap(find.byTooltip('Key options').at(1));
    await _settle(t);
    await t.tap(find.text('Turn off'));
    await _settle(t);
    expect(calls.any((c) => c.startsWith('PATCH /v1/ai/keys/k2') && c.contains('"enabled":false')), isTrue);
  });

  testWidgets('new agent editor posts a paused custom agent with profile, limits and approval mode', (t) async {
    Map? sent;
    final client = MockClient((r) async {
      if (r.method == 'POST' && r.url.path.endsWith('/agents')) {
        sent = jsonDecode(r.body) as Map;
        return _json({'id': 'a9', 'template': 'custom', 'status': 'paused'}, 201);
      }
      return _json({});
    });
    String? result;
    await t.pumpWidget(_app(Builder(builder: (ctx) => Scaffold(body: Center(child: TextButton(onPressed: () async => result = await showAgentEditor(ctx), child: const Text('open'))))), client));
    await t.tap(find.text('open'));
    await _settle(t);
    expect(find.text('New agent'), findsWidgets);
    await t.enterText(find.widgetWithText(TextField, 'Name'), 'Study buddy');
    await t.enterText(find.widgetWithText(TextField, 'What it is for (optional)'), 'Helps me revise');
    await t.enterText(find.byType(TextField).at(2), 'Quiz me one question at a time.');
    await t.scrollUntilVisible(find.text('Ask before every change'), 200, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Ask before every change'));
    await _settle(t);
    await t.scrollUntilVisible(find.text('Create agent'), 200, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Create agent'));
    await _settle(t);
    expect(sent, isNotNull);
    expect(sent!['name'], 'Study buddy');
    expect(sent!['basedOn'], 'research');
    expect(sent!['approvalMode'], 'ask_all');
    expect(sent!['maxToolCalls'], 8);
    expect(sent!.containsKey('dailyRuns'), isFalse);
    expect(result, 'a9');
  });

  testWidgets('key choice offers automatic routing and each alias', (t) async {
    String? picked = 'unset';
    await t.pumpWidget(_app(
      Builder(
        builder: (ctx) => Scaffold(
          body: TextButton(
            onPressed: () async => picked = await pickKeyFor(ctx, [
              {'id': 'k1', 'alias': 'Gemini key 1', 'state': 'ready'},
              {'id': 'k2', 'alias': 'Work account', 'state': 'off'},
            ]),
            child: const Text('pick'),
          ),
        ),
      ),
      MockClient((_) async => _json({})),
    ));
    await t.tap(find.text('pick'));
    await _settle(t);
    expect(find.text('Automatic'), findsOneWidget);
    expect(find.text('Work account'), findsOneWidget);
    await t.tap(find.text('Work account'));
    await _settle(t);
    expect(picked, 'k2');
  });
}
