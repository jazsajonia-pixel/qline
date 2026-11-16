import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/ai.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/screens/auth.dart';
import 'package:qline/ui/core_painter.dart';
import 'package:qline/ui/theme.dart';
import 'package:qline/ui/widgets.dart';

Widget wrap(Widget child, {bool light = false}) => ProviderScope(child: MaterialApp(theme: buildTheme(light), home: Scaffold(body: child)));

void main() {
  testWidgets('status pill always shows a word, not just colour', (t) async {
    await t.pumpWidget(wrap(const Column(children: [StatusPill('done'), StatusPill('awaiting_approval'), StatusPill('failed')])));
    expect(find.text('Done'), findsOneWidget);
    expect(find.text('Awaiting approval'), findsOneWidget);
    expect(find.text('Failed'), findsOneWidget);
    expect(find.byType(Icon), findsNWidgets(3));
  });

  testWidgets('risk tag maps policy levels', (t) async {
    await t.pumpWidget(wrap(const Column(children: [RiskTag('L1'), RiskTag('L2'), RiskTag('L4')])));
    expect(find.text('Low risk'), findsOneWidget);
    expect(find.text('Medium risk'), findsOneWidget);
    expect(find.text('High risk'), findsOneWidget);
  });

  testWidgets('energy core renders every state, animated and reduced', (t) async {
    for (final reduce in [false, true]) {
      for (final s in CoreState.values) {
        await t.pumpWidget(wrap(SizedBox(width: 300, height: 300, child: EnergyCore(state: s, agent: 'sales', reduceMotion: reduce))));
        await t.pump(const Duration(milliseconds: 50));
        expect(t.takeException(), isNull);
        expect(find.bySemanticsLabel('Assistant status: ${coreLabel(s)}'), findsOneWidget);
      }
    }
  });

  testWidgets('halo button disabled state blocks taps', (t) async {
    var taps = 0;
    await t.pumpWidget(wrap(Column(children: [QButton('Approve', kind: QBtn.halo, onPressed: () => taps++), const QButton('Off', onPressed: null)])));
    await t.tap(find.text('Approve'));
    await t.tap(find.text('Off'));
    expect(taps, 1);
  });

  testWidgets('sign-in validates input and offers sign-up', (t) async {
    await t.pumpWidget(ProviderScope(child: MaterialApp(theme: buildTheme(false), home: const WelcomeScreen())));
    await t.pump(const Duration(milliseconds: 50));
    expect(find.text('Welcome back'), findsOneWidget);
    await t.tap(find.text('Sign in'));
    await t.pump();
    expect(find.text('Enter a valid email'), findsOneWidget);
    expect(find.text('Enter your password'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.textContaining('not configured'), findsNothing);
    await t.ensureVisible(find.text('New to Qline? Create an account'));
    await t.tap(find.text('New to Qline? Create an account'));
    await t.pump();
    expect(find.text('Set up your business OS'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextFormField, 'Password'), 'short');
    await t.tap(find.text('Create account'));
    await t.pump();
    expect(find.text('Use at least 10 characters'), findsOneWidget);
  });

  testWidgets('light theme also builds', (t) async {
    await t.pumpWidget(wrap(const EmptyState(icon: Icons.inbox, title: 'Nothing here', body: 'Body'), light: true));
    expect(find.text('Nothing here'), findsOneWidget);
  });

  testWidgets('AI providers lists all five; connecting is optional per provider', (t) async {
    Map<String, dynamic> prov(String id, String name, {bool connected = false}) => {
          'id': id, 'name': name, 'maker': '$name models', 'keyUrl': 'https://example.test', 'costNote': 'Pay as you go.', 'freeTier': id == 'google',
          'connected': connected, 'keyHint': connected ? 'ab12' : null, 'status': connected ? 'ok' : null, 'modelCount': connected ? 3 : 0,
        };
    final overview = {
      'status': 'ready',
      'canManage': true,
      'default': {'provider': 'google', 'model': 'gemini-test'},
      'providers': [prov('openai', 'OpenAI'), prov('anthropic', 'Anthropic'), prov('google', 'Google Gemini', connected: true), prov('xai', 'xAI'), prov('deepseek', 'DeepSeek')],
      'agents': [],
    };
    t.view.physicalSize = const Size(1200, 5000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final api = Api(client: MockClient((r) async => http.Response(jsonEncode(overview), 200, headers: {'content-type': 'application/json'})));
    await t.pumpWidget(ProviderScope(overrides: [apiProvider.overrideWithValue(api)], child: MaterialApp(theme: buildTheme(false), home: const AiProvidersScreen())));
    await t.pumpAndSettle();
    expect(find.text('Google Gemini · gemini-test'), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Not connected'), findsNWidgets(4));
    expect(find.textContaining('Key ending ab12'), findsOneWidget);
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('Add key'), findsNWidgets(4));
    expect(find.text('Replace key'), findsOneWidget);
  });
}
