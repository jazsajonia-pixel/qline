import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/chat_resume.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/live.dart';
import 'package:qline/ui/theme.dart';

/// M2: reopening the chat continues the current conversation; New chat is explicit.

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Signed extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', email: 'Ana@Shop.ph', orgs: [Org('o1', 'Shop', 'owner')], orgId: 'o1');
}

const _key = 'chat.current.o1.ana@shop.ph';

void main() {
  group('resolveConversation', () {
    Future<ChatResume> run(String? stored, {Set<String> exists = const {'c1', 'c2'}, String? latest = 'c2', List<String>? loaded}) => resolveConversation(
      stored: stored,
      load: (id) async {
        loaded?.add(id);
        return exists.contains(id);
      },
      latest: () async => latest,
    );

    test('opens the remembered conversation', () async {
      final loaded = <String>[];
      final r = await run('c1', loaded: loaded);
      expect(r.conversationId, 'c1');
      expect(r.note, isNull);
      expect(loaded, ['c1']);
    });
    test('after New chat, stays new (does not jump back to an old conversation)', () async {
      final loaded = <String>[];
      final r = await run(newChatPointer, loaded: loaded);
      expect(r.conversationId, isNull);
      expect(loaded, isEmpty);
    });
    test('nothing remembered: opens the most recent conversation, or a new chat when there is none', () async {
      expect((await run(null)).conversationId, 'c2');
      expect((await run(null, latest: null)).conversationId, isNull);
      expect((await run(null)).note, isNull);
    });
    test('a deleted or unavailable conversation falls back to the most recent one, with a note', () async {
      final r = await run('gone');
      expect(r.conversationId, 'c2');
      expect(r.note, contains('no longer available'));
      final none = await run('gone', latest: null);
      expect(none.conversationId, isNull);
      expect(none.note, contains('Started a new chat'));
      // The most recent is the unavailable one itself: do not retry it.
      final loaded = <String>[];
      expect((await run('gone', latest: 'gone', loaded: loaded)).conversationId, isNull);
      expect(loaded, ['gone']);
    });
    test('network errors are not hidden as "unavailable"', () async {
      expect(resolveConversation(stored: 'c1', load: (_) async => throw ApiException(0, 'NETWORK', 'No connection'), latest: () async => 'c2'), throwsA(isA<ApiException>()));
    });
  });

  group('pointers', () {
    test('one per organisation and account', () {
      expect(chatPointerKey('o1', ' Ana@Shop.ph '), _key);
      expect(chatPointerKey('o2', 'ana@shop.ph'), isNot(_key));
      expect(chatPointerKey('o1', 'ben@shop.ph'), isNot(_key));
    });
    test('clearAll removes only chat pointers', () async {
      FlutterSecureStorage.setMockInitialValues({'token': 't', _key: 'c1', 'chat.current.o2.ana@shop.ph': 'new', 'prefs.light': '1'});
      const store = SecureChatPointerStore();
      expect(await store.read(_key), 'c1');
      await store.clearAll();
      expect(await const FlutterSecureStorage().readAll(), {'token': 't', 'prefs.light': '1'});
    });
    test('signing out forgets which chat was open', () async {
      FlutterSecureStorage.setMockInitialValues({'token': 't', 'org': 'o1', _key: 'c1'});
      final c = ProviderContainer(
        overrides: [
          apiProvider.overrideWithValue(
            Api(
              client: MockClient(
                (r) async => r.url.path.endsWith('/me')
                    ? _json({
                        'user': {'name': 'Ana', 'email': 'ana@shop.ph'},
                        'orgs': [],
                      })
                    : _json({}),
              ),
            ),
          ),
        ],
      );
      addTearDown(c.dispose);
      c.read(sessionProvider);
      await c.read(sessionProvider.notifier).signOut();
      final left = await const FlutterSecureStorage().readAll();
      expect(left.containsKey(_key), isFalse);
      expect(left.containsKey('token'), isFalse);
    });
  });

  group('Live chat', () {
    Future<(List<String>, MemoryChatPointerStore)> open(WidgetTester t, {String? stored, bool gone = false}) async {
      final calls = <String>[];
      final store = MemoryChatPointerStore();
      if (stored != null) store.values[_key] = stored;
      final api = Api(
        client: MockClient((r) async {
          calls.add('${r.method} ${r.url.path}');
          final p = r.url.path;
          if (p.endsWith('/agents')) {
            return _json({
              'items': [
                {'id': 'a1', 'template': 'ceo', 'name': 'CEO'},
              ],
            });
          }
          if (p.endsWith('/ai/overview')) {
            return _json({
              'status': 'ok',
              'agents': [
                {'id': 'a1', 'ready': true},
              ],
            });
          }
          if (p.endsWith('/conversations')) {
            return _json({
              'items': [
                {'id': 'c2', 'title': 'Latest', 'agent_name': 'CEO', 'template': 'ceo', 'updated_at': DateTime.now().toIso8601String()},
              ],
            });
          }
          if (p.endsWith('/conversations/c1') && gone) return _json({'code': 'NOT_FOUND', 'title': 'Conversation not found'}, 404);
          if (p.contains('/conversations/c')) {
            final id = p.split('/').last;
            return _json({
              'id': id,
              'agent_id': 'a1',
              'active_run': null,
              'messages': [
                {'id': 'm1', 'role': 'user', 'content': 'Hello from $id', 'meta': {}},
                {'id': 'm2', 'role': 'assistant', 'content': 'Answer in $id', 'meta': {}},
              ],
            });
          }
          return _json({});
        }),
      );
      await t.pumpWidget(
        ProviderScope(
          overrides: [apiProvider.overrideWithValue(api), sessionProvider.overrideWith(_Signed.new), chatPointerStoreProvider.overrideWithValue(store)],
          child: MaterialApp(
            theme: buildTheme(false),
            home: const MediaQuery(
              data: MediaQueryData(size: Size(390, 844)),
              child: LiveScreen(),
            ),
          ),
        ),
      );
      await t.pump();
      await t.pump(const Duration(milliseconds: 50));
      return (calls, store);
    }

    testWidgets('reopening continues the remembered conversation instead of creating one', (t) async {
      final (calls, store) = await open(t, stored: 'c1');
      expect(find.textContaining('Answer in c1'), findsOneWidget);
      expect(calls.where((c) => c == 'POST /v1/conversations'), isEmpty);
      expect(store.values[_key], 'c1');
    });

    testWidgets('first open picks the most recent conversation', (t) async {
      final (_, store) = await open(t);
      expect(find.textContaining('Answer in c2'), findsOneWidget);
      expect(store.values[_key], 'c2');
    });

    testWidgets('a removed conversation falls back to the most recent one and says so', (t) async {
      await open(t, stored: 'c1', gone: true);
      expect(find.textContaining('Answer in c2'), findsOneWidget);
      expect(find.textContaining('no longer available'), findsOneWidget);
    });

    testWidgets('New chat clears the screen and is remembered across reopening', (t) async {
      final (calls, store) = await open(t, stored: 'c1');
      await t.tap(find.byTooltip('New chat'));
      await t.pump();
      expect(find.textContaining('Answer in c1'), findsNothing);
      expect(store.values[_key], newChatPointer);
      expect(calls.where((c) => c == 'POST /v1/conversations'), isEmpty, reason: 'a conversation is only created when you send');
    });
  });
}
