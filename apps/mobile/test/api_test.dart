import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qline/core/api.dart';

void main() {
  test('parses problem+json into ApiException', () async {
    final api = Api(client: MockClient((r) async => http.Response(jsonEncode({'code': 'FORBIDDEN', 'title': 'Not allowed', 'detail': 'Viewers cannot edit.'}), 403)));
    try {
      await api.get('/tasks');
      fail('should throw');
    } on ApiException catch (e) {
      expect(e.status, 403);
      expect(e.code, 'FORBIDDEN');
      expect(e.message, 'Viewers cannot edit.');
    }
  });

  test('sends bearer, org and client headers', () async {
    late http.BaseRequest seen;
    final api = Api(client: MockClient((r) async {
      seen = r;
      return http.Response('{"ok":true}', 200);
    }))
      ..token = 't0k'
      ..orgId = 'org1';
    await api.post('/tasks', {'title': 'x'});
    expect(seen.headers['authorization'], 'Bearer t0k');
    expect(seen.headers['x-qline-org'], 'org1');
    expect(seen.headers['x-qline-client'], startsWith('android/'));
    expect(seen.url.path, '/v1/tasks');
  });

  test('401 triggers onUnauthorized', () async {
    var called = false;
    final api = Api(client: MockClient((r) async => http.Response('{"code":"UNAUTHENTICATED","title":"Sign in"}', 401)))..onUnauthorized = () => called = true;
    await expectLater(api.get('/me'), throwsA(isA<ApiException>()));
    expect(called, isTrue);
  });

  test('network failure is reported as offline, not success', () async {
    final api = Api(client: MockClient((r) async => throw http.ClientException('no route')));
    try {
      await api.get('/dashboard');
      fail('should throw');
    } on ApiException catch (e) {
      expect(e.isNetwork, isTrue);
      expect(e.message, contains("Can't reach Qline"));
    }
  });

  test('SSE stream yields typed events with ids, across chunk boundaries', () async {
    const body = 'id: 1\nevent: status\ndata: {"state":"thinking"}\n\n: keepalive\n\nid: 2\nevent: token\ndata: {"text":"Hel"}\n\nid: 3\nevent: token\ndata: {"text":"lo"}\n\nid: 4\nevent: done\ndata: {"status":"completed"}\n\n';
    final api = Api(client: MockClient.streaming((req, _) async {
      final bytes = utf8.encode(body);
      final chunks = [bytes.sublist(0, 17), bytes.sublist(17, 60), bytes.sublist(60)];
      return http.StreamedResponse(Stream.fromIterable(chunks), 200, headers: {'content-type': 'text/event-stream'});
    }));
    final events = await api.sse('/runs/x/stream').toList();
    expect(events.map((e) => e.event).toList(), ['status', 'token', 'token', 'done']);
    expect(events.map((e) => e.id).toList(), ['1', '2', '3', '4']);
    expect(events.where((e) => e.event == 'token').map((e) => e.data['text']).join(), 'Hello');
  });

  test('auth returns token from header or body', () async {
    final api = Api(client: MockClient((r) async => http.Response(jsonEncode({'token': 'body-token', 'user': {}}), 200, headers: {'set-auth-token': 'hdr-token'})));
    expect(await api.auth('sign-in/email', {'email': 'a@b.co', 'password': 'x'}), 'hdr-token');
    final api2 = Api(client: MockClient((r) async => http.Response(jsonEncode({'token': 'body-token', 'user': {}}), 200)));
    expect(await api2.auth('sign-in/email', {'email': 'a@b.co', 'password': 'x'}), 'body-token');
  });
}
