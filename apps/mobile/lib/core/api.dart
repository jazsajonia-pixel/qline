import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'config.dart';

/// Error from the API, parsed from application/problem+json.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.title, [this.detail]);
  final int status;
  final String code;
  final String title;
  final String? detail;

  bool get isNetwork => status == 0;
  bool get isAuth => status == 401;

  /// Plain-language message for the UI.
  String get message {
    if (isNetwork) return "Can't reach Qline. Check your connection and try again.";
    if (detail != null && detail!.isNotEmpty) return detail!;
    return title;
  }

  @override
  String toString() => 'ApiException($status $code: $message)';
}

class SseEvent {
  SseEvent(this.id, this.event, this.data);
  final String? id;
  final String event;
  final Map<String, dynamic> data;
}

class Api {
  Api({http.Client? client}) : _client = client ?? http.Client();
  final http.Client _client;
  String? token;
  String? orgId;
  void Function()? onUnauthorized;

  Uri _uri(String path, [Map<String, dynamic>? query]) {
    final q = <String, String>{};
    query?.forEach((k, v) {
      if (v != null && '$v'.isNotEmpty) q[k] = '$v';
    });
    return Uri.parse('${AppConfig.apiBase}/v1$path').replace(queryParameters: q.isEmpty ? null : q);
  }

  Map<String, String> _headers({bool json = true, Map<String, String>? extra}) => {
        if (json) 'content-type': 'application/json',
        'accept': 'application/json',
        'x-qline-client': 'android/${AppConfig.build}',
        if (token != null) 'authorization': 'Bearer $token',
        'x-qline-org': ?orgId,
        ...?extra,
      };

  Future<dynamic> _send(Future<http.Response> Function() fn) async {
    http.Response res;
    try {
      res = await fn().timeout(const Duration(seconds: 45));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', 'The request took too long');
    } catch (e) {
      throw ApiException(0, 'NETWORK', 'Network error');
    }
    return _decode(res.statusCode, res.body, res.headers);
  }

  dynamic _decode(int status, String body, Map<String, String> headers) {
    dynamic data;
    try {
      data = body.isEmpty ? null : jsonDecode(body);
    } catch (_) {
      data = null;
    }
    if (status >= 200 && status < 300) return data;
    final m = data is Map ? data : const {};
    final err = ApiException(status, (m['code'] ?? 'HTTP_$status').toString(), (m['title'] ?? m['message'] ?? 'Request failed').toString(), m['detail']?.toString() ?? m['message']?.toString());
    if (status == 401) onUnauthorized?.call();
    throw err;
  }

  Future<dynamic> get(String path, [Map<String, dynamic>? query]) => _send(() => _client.get(_uri(path, query), headers: _headers(json: false)));
  Future<dynamic> post(String path, [Object? body, Map<String, String>? headers]) =>
      _send(() => _client.post(_uri(path), headers: _headers(extra: headers), body: jsonEncode(body ?? {})));
  /// Sends [text] as it is (no JSON re-encoding), for pasted reports whose exact bytes the server checks.
  Future<dynamic> postRaw(String path, String text) => _send(() => _client.post(_uri(path), headers: _headers(), body: text));
  Future<dynamic> put(String path, [Object? body]) => _send(() => _client.put(_uri(path), headers: _headers(), body: jsonEncode(body ?? {})));
  Future<dynamic> patch(String path, [Object? body]) => _send(() => _client.patch(_uri(path), headers: _headers(), body: jsonEncode(body ?? {})));
  Future<dynamic> delete(String path) => _send(() => _client.delete(_uri(path), headers: _headers(json: false)));

  /// Better Auth sign-in / sign-up. Returns the bearer token.
  Future<String> auth(String path, Map<String, dynamic> body) async {
    final res = await _client
        .post(_uri('/auth/$path'), headers: {'content-type': 'application/json', 'x-qline-client': 'android/${AppConfig.build}'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 45))
        .catchError((Object _) => throw ApiException(0, 'NETWORK', 'Network error'));
    if (res.statusCode >= 400) {
      Map m = const {};
      try {
        m = jsonDecode(res.body) as Map;
      } catch (_) {}
      throw ApiException(res.statusCode, (m['code'] ?? 'AUTH_FAILED').toString(), (m['message'] ?? 'Sign-in failed').toString());
    }
    final headerToken = res.headers['set-auth-token'];
    final data = jsonDecode(res.body) as Map;
    final t = headerToken ?? data['token'] as String?;
    if (t == null) throw ApiException(500, 'NO_TOKEN', 'Sign-in did not return a session');
    return t;
  }

  Future<void> signOut() async {
    try {
      await _client.post(_uri('/auth/sign-out'), headers: _headers(), body: '{}').timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  Future<dynamic> upload(String path, String fileName, Uint8List bytes) async {
    final req = http.MultipartRequest('POST', _uri(path));
    req.headers.addAll(_headers(json: false));
    req.files.add(http.MultipartFile.fromBytes('file', bytes, filename: fileName));
    try {
      final streamed = await _client.send(req).timeout(const Duration(seconds: 120));
      final body = await streamed.stream.bytesToString();
      return _decode(streamed.statusCode, body, streamed.headers);
    } on ApiException {
      rethrow;
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'Upload failed');
    }
  }

  Future<Uint8List> download(String path) async {
    final res = await _client.get(_uri(path), headers: _headers(json: false)).timeout(const Duration(seconds: 120));
    if (res.statusCode >= 300) _decode(res.statusCode, res.body, res.headers);
    return res.bodyBytes;
  }

  /// Server-sent events (run stream). Reconnects are handled by the caller with [lastEventId].
  Stream<SseEvent> sse(String path, {String? lastEventId}) async* {
    final req = http.Request('GET', _uri(path));
    req.headers.addAll(_headers(json: false, extra: {'accept': 'text/event-stream', 'last-event-id': ?lastEventId}));
    final res = await _client.send(req);
    if (res.statusCode >= 300) {
      final body = await res.stream.bytesToString();
      _decode(res.statusCode, body, res.headers);
    }
    String? id;
    String event = 'message';
    final data = StringBuffer();
    await for (final line in res.stream.transform(utf8.decoder).transform(const LineSplitter())) {
      if (line.isEmpty) {
        if (data.isNotEmpty) {
          Map<String, dynamic> parsed;
          try {
            parsed = (jsonDecode(data.toString()) as Map).cast<String, dynamic>();
          } catch (_) {
            parsed = {'raw': data.toString()};
          }
          yield SseEvent(id, event, parsed);
        }
        id = null;
        event = 'message';
        data.clear();
        continue;
      }
      if (line.startsWith(':')) continue;
      final i = line.indexOf(':');
      final field = i < 0 ? line : line.substring(0, i);
      var value = i < 0 ? '' : line.substring(i + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      switch (field) {
        case 'id':
          id = value;
        case 'event':
          event = value;
        case 'data':
          if (data.isNotEmpty) data.write('\n');
          data.write(value);
      }
    }
  }
}
