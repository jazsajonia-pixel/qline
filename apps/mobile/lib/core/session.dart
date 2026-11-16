import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';

class Org {
  Org(this.id, this.name, this.role);
  final String id;
  final String name;
  final String role;
  factory Org.fromJson(Map j) => Org(j['id'] as String, j['name'] as String, j['role'] as String);
}

class SessionState {
  const SessionState({this.loading = true, this.token, this.userName, this.email, this.orgs = const [], this.orgId});
  final bool loading;
  final String? token;
  final String? userName;
  final String? email;
  final List<Org> orgs;
  final String? orgId;

  bool get signedIn => token != null;
  Org? get org => orgs.where((o) => o.id == orgId).firstOrNull;
  String get role => org?.role ?? 'viewer';
  bool get canManage => role == 'owner' || role == 'admin';
  bool get canWrite => role != 'viewer';

  SessionState copy({bool? loading, String? token, String? userName, String? email, List<Org>? orgs, String? orgId, bool clearOrg = false}) => SessionState(
        loading: loading ?? this.loading,
        token: token ?? this.token,
        userName: userName ?? this.userName,
        email: email ?? this.email,
        orgs: orgs ?? this.orgs,
        orgId: clearOrg ? null : (orgId ?? this.orgId),
      );
}

final apiProvider = Provider<Api>((ref) => Api());

final sessionProvider = NotifierProvider<SessionNotifier, SessionState>(SessionNotifier.new);

class SessionNotifier extends Notifier<SessionState> {
  static const _storage = FlutterSecureStorage();
  Api get _api => ref.read(apiProvider);

  @override
  SessionState build() {
    _api.onUnauthorized = () {
      if (state.signedIn) _clear();
    };
    Future.microtask(_restore);
    return const SessionState();
  }

  Future<void> _restore() async {
    try {
      final token = await _storage.read(key: 'token');
      final org = await _storage.read(key: 'org');
      if (token == null) {
        state = const SessionState(loading: false);
        return;
      }
      _api.token = token;
      await _loadMe(token, preferredOrg: org);
    } catch (_) {
      state = const SessionState(loading: false);
    }
  }

  Future<void> _loadMe(String token, {String? preferredOrg}) async {
    try {
      final me = await _api.get('/me') as Map;
      final orgs = (me['orgs'] as List).map((o) => Org.fromJson(o as Map)).toList();
      final orgId = orgs.any((o) => o.id == preferredOrg) ? preferredOrg : (orgs.isNotEmpty ? orgs.first.id : null);
      _api.orgId = orgId;
      if (orgId != null) await _storage.write(key: 'org', value: orgId);
      state = SessionState(loading: false, token: token, userName: me['user']['name'] as String?, email: me['user']['email'] as String?, orgs: orgs, orgId: orgId);
    } on ApiException catch (e) {
      if (e.isAuth) {
        await _clear();
      } else {
        // Offline: keep the token, let the user retry.
        state = SessionState(loading: false, token: token, orgId: preferredOrg);
        _api.orgId = preferredOrg;
        rethrow;
      }
    }
  }

  Future<void> refresh() async {
    if (state.token != null) await _loadMe(state.token!, preferredOrg: state.orgId);
  }

  Future<void> signIn(String email, String password) async {
    final t = await _api.auth('sign-in/email', {'email': email.trim(), 'password': password});
    await _start(t);
  }

  Future<void> signUp(String name, String email, String password) async {
    final t = await _api.auth('sign-up/email', {'name': name.trim(), 'email': email.trim(), 'password': password});
    await _start(t);
  }

  /// Finishes a sign-in that happened outside the email form (Continue with Google).
  Future<void> signInWithToken(String token) => _start(token);

  /// Exposed for the Google sign-in handshake (public endpoints, no token needed).
  Api get api => _api;

  Future<void> _start(String token) async {
    _api.token = token;
    await _storage.write(key: 'token', value: token);
    await _loadMe(token);
  }

  Future<void> createOrg(String name) async {
    final r = await _api.post('/orgs', {'name': name.trim()}) as Map;
    await _storage.write(key: 'org', value: r['id'] as String);
    await _loadMe(state.token!, preferredOrg: r['id'] as String);
  }

  Future<void> joinOrg(String code) async {
    final r = await _api.post('/invitations/accept', {'code': code.trim()}) as Map;
    await _loadMe(state.token!, preferredOrg: r['orgId'] as String);
  }

  Future<void> switchOrg(String id) async {
    _api.orgId = id;
    await _storage.write(key: 'org', value: id);
    state = state.copy(orgId: id);
  }

  Future<void> signOut() async {
    await _api.signOut();
    await _clear();
  }

  Future<void> _clear() async {
    _api.token = null;
    _api.orgId = null;
    await _storage.delete(key: 'token');
    await _storage.delete(key: 'org');
    state = const SessionState(loading: false);
  }
}

/// Bumped after mutations so dependent screens reload.
final refreshTick = NotifierProvider<RefreshTick, int>(RefreshTick.new);

class RefreshTick extends Notifier<int> {
  @override
  int build() => 0;
  void bump() => state++;
}

/// User display preferences.
class Prefs {
  const Prefs({this.light = false, this.reduceMotion = false, this.speak = false});
  final bool light;
  final bool reduceMotion;
  final bool speak;
}

final prefsProvider = NotifierProvider<PrefsNotifier, Prefs>(PrefsNotifier.new);

class PrefsNotifier extends Notifier<Prefs> {
  static const _storage = FlutterSecureStorage();
  @override
  Prefs build() {
    Future.microtask(() async {
      final v = await _storage.read(key: 'prefs');
      if (v != null) {
        final p = v.split(',');
        state = Prefs(light: p.contains('light'), reduceMotion: p.contains('reduce'), speak: p.contains('speak'));
      }
    });
    return const Prefs();
  }

  void set({bool? light, bool? reduceMotion, bool? speak}) {
    state = Prefs(light: light ?? state.light, reduceMotion: reduceMotion ?? state.reduceMotion, speak: speak ?? state.speak);
    _storage.write(key: 'prefs', value: [if (state.light) 'light', if (state.reduceMotion) 'reduce', if (state.speak) 'speak'].join(','));
  }
}
