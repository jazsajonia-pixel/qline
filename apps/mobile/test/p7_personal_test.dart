import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/auth.dart';
import 'package:qline/screens/domains.dart';
import 'package:qline/ui/theme.dart';

/// Phase 7 (docs/21, ADR-1 + M11): start with a personal space; no business name needed.

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

final _calls = <String>[];

class _NoOrg extends SessionNotifier {
  @override
  SessionState build() => const SessionState(loading: false, token: 't', email: 'lia@mail.ph');
  @override
  Future<void> createPersonal() async => _calls.add('personal');
  @override
  Future<void> createOrg(String name) async => _calls.add('business:$name');
}

class _Personal extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'lia@mail.ph', orgs: [Org('o1', 'Personal', 'owner', kind: 'personal')], orgId: 'o1');
}

Widget _app(Widget child, {http.Client? client, SessionNotifier Function()? session}) => ProviderScope(
  overrides: [if (client != null) apiProvider.overrideWithValue(Api(client: client)), sessionProvider.overrideWith(session ?? _NoOrg.new)],
  child: MaterialApp(theme: buildTheme(false), home: child),
);

Future<void> _settle(WidgetTester t) async {
  for (var i = 0; i < 10; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

void main() {
  setUp(_calls.clear);

  testWidgets('first run defaults to a personal space: one tap, no business name', (t) async {
    await t.pumpWidget(_app(const OrgSetupScreen()));
    await _settle(t);
    expect(find.text('Your personal space'), findsOneWidget);
    expect(find.text('Business name'), findsNothing);
    await t.tap(find.text('Start'));
    await _settle(t);
    expect(_calls, ['personal']);
  });

  testWidgets('a business space is still one choice away', (t) async {
    await t.pumpWidget(_app(const OrgSetupScreen()));
    await _settle(t);
    await t.tap(find.text('Business'));
    await _settle(t);
    expect(find.text('Name your business'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'Lia Bakes');
    await t.tap(find.text('Create business space'));
    await _settle(t);
    expect(_calls, ['business:Lia Bakes']);
  });

  testWidgets('domains list, hide and add call the API', (t) async {
    final client = MockClient((r) async {
      _calls.add('${r.method} ${r.url.path} ${r.body}');
      if (r.method == 'GET') {
        return _json({
          'items': [
            {'id': 'd1', 'name': 'Personal', 'icon': 'person', 'enabled': true, 'position': 0, 'open_tasks': 2},
            {'id': 'd2', 'name': 'Money', 'icon': 'savings', 'enabled': true, 'position': 1, 'open_tasks': 0},
          ],
        });
      }
      return _json({'id': 'd3', 'name': 'Music'}, r.method == 'POST' ? 201 : 200);
    });
    await t.pumpWidget(_app(const DomainsScreen(), client: client, session: _Personal.new));
    await _settle(t);
    expect(find.text('Personal'), findsOneWidget);
    expect(find.text('2 open tasks'), findsOneWidget);
    await t.tap(find.byType(Switch).last);
    await _settle(t);
    expect(_calls.any((c) => c.startsWith('PATCH /v1/domains/d2') && c.contains('"enabled":false')), isTrue);
    await t.tap(find.text('Add domain'));
    await _settle(t);
    await t.enterText(find.byType(TextField), 'Music');
    await t.tap(find.text('Add'));
    await _settle(t);
    expect(_calls.any((c) => c.startsWith('POST /v1/domains') && c.contains('Music')), isTrue);
  });
}
