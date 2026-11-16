import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/core/voice.dart';
import 'package:qline/screens/integrations.dart';
import 'package:qline/screens/leads.dart';
import 'package:qline/screens/live.dart';
import 'package:qline/ui/core_painter.dart';
import 'package:qline/ui/theme.dart';
import 'package:qline/ui/widgets.dart';

/// Screenshots for visual review: `QLINE_SHOTS=1 flutter test test/v12_test.dart --update-goldens`
final shots = Platform.environment['QLINE_SHOTS'] == '1';

Future<void> loadFonts() async {
  for (final (fam, file) in [('HankenGrotesk', 'assets/fonts/HankenGrotesk.ttf'), ('JetBrainsMono', 'assets/fonts/JetBrainsMono.ttf'), ('MaterialIcons', null)]) {
    final loader = FontLoader(fam);
    if (file != null) {
      loader.addFont(Future.value(ByteData.sublistView(File(file).readAsBytesSync())));
    } else {
      final root = Platform.environment['FLUTTER_ROOT'] ?? '/home/user/tools/flutter';
      final f = File('$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
      if (!f.existsSync()) continue;
      loader.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
    }
    await loader.load();
  }
}

Api mockApi(Map<String, Object> routes) => Api(
      client: MockClient((r) async {
        final key = '${r.method} ${r.url.path.replaceFirst('/v1', '')}';
        final body = routes[key] ?? routes[r.url.path.replaceFirst('/v1', '')];
        if (body == null) return http.Response(jsonEncode({'title': 'Not found', 'code': 'NOT_FOUND'}), 404, headers: {'content-type': 'application/json'});
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
      }),
    );

Widget app(Api api, Widget home, {bool light = false}) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(api)],
      child: MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(light), home: home),
    );

final integrations = {
  'providers': [
    {
      'id': 'google',
      'name': 'Google',
      'registered': true,
      'connection': {
        'provider': 'google',
        'accountEmail': 'owner@example.com',
        'status': 'ok',
        'settings': {
          'sheet': {'id': 's1', 'url': 'https://docs.google.com/spreadsheets/d/s1'},
        },
        'features': ['gmail', 'sheets'],
        'connectedAt': '2026-11-10T02:00:00Z',
        'lastSyncAt': '2026-11-16T01:00:00Z',
      },
      'features': [
        {'id': 'gmail', 'name': 'Gmail lead inbox', 'detail': 'Reads new inbox emails.'},
        {'id': 'sheets', 'name': 'Google Sheets', 'detail': 'Two-way leads sheet.'},
        {'id': 'forms', 'name': 'Google Forms', 'detail': 'Lead form.'},
        {'id': 'calendar', 'name': 'Google Calendar', 'detail': 'Events.'},
      ],
    },
    {
      'id': 'microsoft',
      'name': 'Microsoft',
      'registered': false,
      'connection': null,
      'features': [
        {'id': 'outlook', 'name': 'Outlook lead inbox', 'detail': ''},
      ],
    },
    {
      'id': 'slack',
      'name': 'Slack',
      'registered': true,
      'connection': null,
      'features': [
        {'id': 'slack', 'name': 'Slack alerts', 'detail': ''},
      ],
    },
  ],
  'other': [
    {'id': 'notion', 'name': 'Notion', 'category': 'Docs', 'status': 'planned', 'detail': 'Planned.'},
  ],
  'canSetup': true,
};

final inbox = {
  'items': [
    {'id': 'i1', 'source': 'gmail', 'from_email': 'dana@acme.test', 'from_name': 'Dana Cruz', 'subject': 'Need a quote today for 40 units', 'summary': 'Wants pricing for 40 units, needs an answer today.', 'is_lead': true, 'urgency': 'urgent', 'reason': 'Urgent word “today”; lead word “quote”', 'classified_by': 'rules', 'created_at': '2026-11-16T03:00:00Z'},
    {'id': 'i2', 'source': 'form', 'from_email': 'li@shop.test', 'from_name': 'Li Wen', 'subject': 'Website form', 'summary': 'Asking about monthly cleaning plans.', 'is_lead': true, 'urgency': 'normal', 'reason': 'Form response', 'classified_by': 'ai', 'created_at': '2026-11-16T01:00:00Z'},
  ],
  'counts': {'leads': 2, 'urgent': 1, 'ignored': 4, 'today': 2},
};

void main() {
  setUpAll(() async {
    FlutterSecureStorage.setMockInitialValues({});
    await loadFonts();
  });

  test('speakable strips markdown and links; chunk gives a short opener', () {
    expect(speakable('**Hi** there, see [the doc](https://x.y) or https://a.b now.\n- one\n- two'), 'Hi there, see the doc or a link now. one two');
    final parts = chunk('First sentence is short. ${'This is a longer sentence that goes on. ' * 20}');
    expect(parts.first.length, lessThanOrEqualTo(220));
    expect(parts.length, greaterThan(1));
    expect(parts.every((p) => p.length <= 1200), isTrue);
    expect(wordsOf('  a  b c '), ['a', 'b', 'c']);
  });

  testWidgets('urgency pill always has a word', (t) async {
    await t.pumpWidget(MaterialApp(theme: buildTheme(false), home: const Scaffold(body: Column(children: [UrgencyPill('urgent'), UrgencyPill('high'), UrgencyPill('normal'), UrgencyPill(null)]))));
    for (final w in ['Urgent', 'Hot', 'Normal', 'Low']) {
      expect(find.text(w), findsOneWidget);
    }
  });

  for (final light in [false, true]) {
    testWidgets('integrations: connected, waiting-for-setup and connectable states (${light ? 'light' : 'dark'})', (t) async {
      t.view.physicalSize = const Size(1080, 2340);
      t.view.devicePixelRatio = 2.625;
      addTearDown(t.view.reset);
      await t.pumpWidget(app(mockApi({'/integrations': integrations}), const IntegrationsScreen(), light: light));
      await t.pumpAndSettle();
      expect(find.text('owner@example.com'), findsOneWidget);
      expect(find.text('Waiting for app setup'), findsOneWidget);
      expect(find.text('Connect with Slack'), findsOneWidget);
      expect(find.textContaining('You own this Qline server'), findsOneWidget);
      if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/integrations_${light ? 'light' : 'dark'}.png'));
    });

    testWidgets('lead inbox shows urgency, reason and counts (${light ? 'light' : 'dark'})', (t) async {
      t.view.physicalSize = const Size(1080, 2340);
      t.view.devicePixelRatio = 2.625;
      addTearDown(t.view.reset);
      await t.pumpWidget(app(mockApi({'/leads/inbox': inbox}), const LeadInboxScreen(), light: light));
      await t.pumpAndSettle();
      expect(find.text('Dana Cruz'), findsOneWidget);
      expect(find.text('Urgent'), findsOneWidget);
      expect(find.text('Leads · 2'), findsOneWidget);
      expect(find.textContaining('lead word'), findsOneWidget);
      if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/inbox_${light ? 'light' : 'dark'}.png'));
    });
  }

  testWidgets('lead rules: chips and notify choices render', (t) async {
    t.view.physicalSize = const Size(1080, 4000);
    t.view.devicePixelRatio = 2.625;
    addTearDown(t.view.reset);
    final rules = {'enabled': true, 'useAi': true, 'instructions': '', 'leadKeywords': ['quote', 'pricing'], 'urgentKeywords': ['asap'], 'vipDomains': [], 'ignoreDomains': ['news.test'], 'notifyOn': 'all', 'slackOn': 'urgent'};
    await t.pumpWidget(app(mockApi({'/leads/rules': rules}), const LeadRulesScreen()));
    await t.pumpAndSettle();
    expect(find.text('quote'), findsOneWidget);
    expect(find.text('news.test'), findsOneWidget);
    expect(find.text('Slack alerts'), findsOneWidget);
    if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/rules_dark.png'));
  });

  testWidgets('reveal is static when motion is reduced', (t) async {
    await t.pumpWidget(ProviderScope(child: MaterialApp(home: MediaQuery(data: const MediaQueryData(disableAnimations: true), child: const Reveal(index: 3, child: Text('hi'))))));
    expect(find.text('hi'), findsOneWidget);
    expect(find.byType(Opacity), findsNothing);
  });

  testWidgets('live captions light the spoken word; hands-free bar explains state', (t) async {
    t.view.physicalSize = const Size(1080, 1400);
    t.view.devicePixelRatio = 2.625;
    addTearDown(t.view.reset);
    const text = 'You have two new leads this morning, and one of them looks urgent. Dana wants a quote today.';
    await t.pumpWidget(ProviderScope(
      child: MaterialApp(
        theme: buildTheme(false),
        home: Scaffold(
          backgroundColor: const Color(0xFF07060D),
          body: Column(children: [
            const SizedBox(height: 260, child: EnergyCore(state: CoreState.speaking, level: .7, reduceMotion: true)),
            const LiveCaption(text: text, word: 6, visible: true, reduceMotion: true),
            HandsFreeBar(listening: false, speaking: true, onEnd: () {}),
          ]),
        ),
      ),
    ));
    await t.pump(const Duration(milliseconds: 100));
    final rich = t.widget<Text>(find.byWidgetPredicate((w) => w is Text && w.textSpan != null).first);
    expect(rich.textSpan!.toPlainText(), contains('morning,'));
    expect(find.text('Hands-free · tap the core to interrupt'), findsOneWidget);
    if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/live_caption.png'));
  });
}
