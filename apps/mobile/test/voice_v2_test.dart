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
import 'package:qline/core/chat_resume.dart';
import 'package:qline/core/live_status.dart';
import 'package:qline/core/session.dart';
import 'package:qline/core/voice.dart';
import 'package:qline/screens/live.dart';
import 'package:qline/screens/shell.dart';
import 'package:qline/ui/core_painter.dart';
import 'package:qline/ui/theme.dart';

/// Voice v2 and background continuity (docs/26).

class _Signed extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'ana@shop.ph', orgs: [Org('o1', 'Shop', 'owner')], orgId: 'o1');
}

Widget _app(Widget child, {required http.Client client}) => ProviderScope(
      overrides: [
        apiProvider.overrideWithValue(Api(client: client)),
        sessionProvider.overrideWith(_Signed.new),
        chatPointerStoreProvider.overrideWithValue(MemoryChatPointerStore()),
      ],
      child: MaterialApp(theme: buildTheme(false), home: child),
    );

Future<void> _settle(WidgetTester t) async {
  for (var i = 0; i < 12; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

String _sse(List<(String, Map<String, dynamic>)> events) => [for (var i = 0; i < events.length; i++) 'id: $i\nevent: ${events[i].$1}\ndata: ${jsonEncode(events[i].$2)}\n\n'].join();

void main() {
  group('Voice v2 helpers', () {
    test('picks the recogniser locale, including Filipino published as tl', () {
      expect(pickLocale('auto', ['en_US']), isNull);
      expect(pickLocale('fil-PH', ['en_US', 'fil_PH']), 'fil_PH');
      expect(pickLocale('fil-PH', ['en_US', 'tl_PH']), 'tl_PH');
      expect(pickLocale('en-PH', ['en_US', 'en_PH']), 'en_PH');
      expect(pickLocale('en-PH', ['en_US']), 'en_US');
      expect(pickLocale('fil-PH', ['en_US', 'ja_JP']), isNull);
    });

    test('barge-in ignores the echo of its own voice and catches real interruptions', () {
      const said = 'You have three open tasks, two are overdue.';
      expect(isBargeIn('you have three open', said), isFalse);
      expect(isBargeIn('three tasks', said), isFalse);
      expect(isBargeIn('teka', said), isTrue);
      expect(isBargeIn('stop', said), isTrue);
      expect(isBargeIn('show me the leads instead', said), isTrue);
      expect(withoutEcho('you have three show me leads', said), 'show me leads');
    });

    test('waits longer after a dangling Filipino connector', () {
      const base = Duration(milliseconds: 1300);
      expect(waitFor('ipakita mo yung tasks ko kasi', base) > waitFor('ipakita mo yung tasks ko ngayon', base), isTrue);
      expect(waitFor('gumawa ka ng task para', base).inMilliseconds, 2200);
    });

    test('voice settings keep the listening language and barge-in', () {
      final p = VoicePrefs.fromJson(const VoicePrefs(listenLang: 'fil-PH', bargeIn: false).toJson());
      expect(p.listenLang, 'fil-PH');
      expect(p.bargeIn, isFalse);
      expect(VoicePrefs.fromJson({'listenLang': 'xx'}).listenLang, 'auto');
      expect(VoicePrefs.fromJson(const {}).bargeIn, isTrue);
    });

    test('the navbar orb maps every live state to one it can show', () {
      expect(navCoreState(CoreState.tool), CoreState.thinking);
      expect(navCoreState(CoreState.success), CoreState.idle);
      expect(navCoreState(CoreState.error), CoreState.offline);
      expect(navCoreState(CoreState.speaking), CoreState.speaking);
      expect(navOrbLabel(const LiveStatus(core: CoreState.listening), open: false), 'Return to Live AI, listening');
      expect(navOrbLabel(const LiveStatus(), open: false), 'Open Live AI');
      expect(navOrbLabel(const LiveStatus(core: CoreState.offline), open: false), 'Return to Live AI, disconnected');
    });
  });

  group('Background continuity', () {
    setUp(() {
      FlutterSecureStorage.setMockInitialValues({});
      // Sending stops any voice playback first; these plugins have no implementation in tests.
      for (final ch in ['xyz.luan/audioplayers', 'xyz.luan/audioplayers.global', 'xyz.luan/audioplayers.global/events', 'flutter_tts', 'plugin.csdcorp.com/speech_to_text', 'wakelock_plus']) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (_) async => null);
      }
    });
    testWidgets('minimizing keeps the answer streaming; it never cancels the run; the orb shows the state', (t) async {
      t.view.physicalSize = const Size(390, 844);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      final calls = <String>[];
      final stream = StreamController<List<int>>();
      Map<String, dynamic>? sent;
      final client = MockClient.streaming((r, body) async {
        final p = r.url.path;
        calls.add('${r.method} $p');
        http.StreamedResponse ok(Object o) => http.StreamedResponse(Stream.value(utf8.encode(jsonEncode(o))), 200, headers: {'content-type': 'application/json'});
        if (p.endsWith('/agents')) {
          return ok({
            'items': [
              {'id': 'a1', 'template': 'ceo', 'name': 'Command Center'},
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
        if (p.endsWith('/conversations') && r.method == 'POST') return ok({'id': 'c1'});
        if (p.endsWith('/conversations/c1/messages')) {
          sent = jsonDecode(await body.bytesToString()) as Map<String, dynamic>;
          return ok({'runId': 'r1'});
        }
        if (p.endsWith('/runs/r1/stream')) return http.StreamedResponse(stream.stream, 200, headers: {'content-type': 'text/event-stream'});
        return ok({'items': []});
      });
      await t.pumpWidget(_app(const Shell(), client: client));
      await t.pump(const Duration(milliseconds: 100));
      expect(find.bySemanticsLabel('Open Live AI'), findsOneWidget);

      await t.tap(find.bySemanticsLabel('Open Live AI'));
      await _settle(t);
      expect(find.byTooltip('Minimize'), findsOneWidget);
      await t.enterText(find.byType(TextField).last, 'How many open tasks?');
      await t.tap(find.byTooltip('Send').last);
      await _settle(t);
      expect(calls, contains('POST /v1/conversations/c1/messages'));
      expect(sent?['content'], 'How many open tasks?');
      expect(sent?.containsKey('voice'), isFalse); // typed, not spoken
      stream.add(utf8.encode(_sse([('token', {'text': 'You have '})])));
      await t.pump(const Duration(milliseconds: 100));

      // Minimize while the answer is being written.
      await t.tap(find.byTooltip('Minimize'));
      await _settle(t);
      expect(find.byTooltip('Minimize'), findsNothing); // hidden (offstage), not disposed
      expect(find.byTooltip('Minimize', skipOffstage: false), findsOneWidget);
      expect(find.bySemanticsLabel('Return to Live AI, thinking'), findsOneWidget);

      // The rest of the answer arrives while minimized.
      stream.add(utf8.encode('id: 1\nevent: token\ndata: ${jsonEncode({'text': '**3 open tasks**.'})}\n\nid: 2\nevent: done\ndata: ${jsonEncode({'status': 'completed'})}\n\n'));
      await stream.close();
      await _settle(t);
      expect(find.bySemanticsLabel('Open Live AI'), findsOneWidget); // back to idle once done

      // Back in Live AI: the conversation and the finished answer are still there.
      await t.tap(find.bySemanticsLabel('Open Live AI'));
      await _settle(t);
      expect(find.textContaining('3 open tasks', findRichText: true), findsWidgets);
      expect(calls.where((c) => c.contains('/cancel')), isEmpty);

      // Android Back in Live AI minimizes (no exit question).
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.text('Close Qline?'), findsNothing);
      expect(find.byTooltip('Minimize'), findsNothing);
    });
  });

  test('LiveScreen still works as a pushed screen (old entry points)', () {
    expect(const LiveScreen().embedded, isFalse);
  });
}
