import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'session.dart';

/// Unread in-app notifications, refreshed with refreshTick and by [AlertWatcher].
final unreadAlerts = NotifierProvider<UnreadAlerts, int>(UnreadAlerts.new);

class UnreadAlerts extends Notifier<int> {
  @override
  int build() => 0;
  void set(int n) => state = n;
}

/// Turns new Qline notifications (important email, new leads, approvals, workflow results,
/// the assistant's "notify me") into Android notifications.
///
/// It checks every [interval] while the app is open and whenever it comes back to the
/// foreground. When the app is fully closed nothing is checked; real push needs Firebase
/// Cloud Messaging (see the v1.3 handoff).
class AlertWatcher extends ConsumerStatefulWidget {
  const AlertWatcher({super.key, required this.child, this.interval = const Duration(seconds: 60)});
  final Widget child;
  final Duration interval;
  @override
  ConsumerState<AlertWatcher> createState() => _AlertWatcherState();
}

class _AlertWatcherState extends ConsumerState<AlertWatcher> with WidgetsBindingObserver {
  static const _storage = FlutterSecureStorage();
  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _ready = false;
  static const _channel = AndroidNotificationDetails(
    'qline_alerts',
    'Qline alerts',
    channelDescription: 'Important email, new leads, approvals and assistant reminders',
    importance: Importance.high,
    priority: Priority.high,
    color: Color(0xFFF5C451),
  );
  Timer? _timer;
  bool _busy = false;

  /// Widget tests have no notification plugin and must not leave timers running.
  static bool get _enabled => !Platform.environment.containsKey('FLUTTER_TEST');

  @override
  void initState() {
    super.initState();
    if (!_enabled) return;
    WidgetsBinding.instance.addObserver(this);
    _init().then((_) => _check());
    _timer = Timer.periodic(widget.interval, (_) => _check());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _check();
  }

  Future<void> _init() async {
    if (_ready) return;
    try {
      await _plugin.initialize(settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')));
      await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      _ready = true;
    } catch (_) {
      // No notifications on this device; the in-app bell still works.
    }
  }

  Future<void> _check() async {
    final s = ref.read(sessionProvider);
    if (_busy || !s.signedIn || s.orgId == null) return;
    _busy = true;
    try {
      final r = await ref.read(apiProvider).get('/notifications') as Map;
      final list = ((r['items'] as List?) ?? const []).cast<Map>();
      ref.read(unreadAlerts.notifier).set((r['unread'] as num?)?.toInt() ?? 0);
      final key = 'alerts_seen_${s.orgId}';
      final seen = await _storage.read(key: key);
      final newest = list.isEmpty ? null : list.first['created_at']?.toString();
      if (seen == null) {
        // First run for this workspace: don't replay old notifications.
        await _storage.write(key: key, value: newest ?? DateTime.now().toUtc().toIso8601String());
        return;
      }
      final fresh = newAlerts(list, seen);
      if (fresh.isEmpty) return;
      await _storage.write(key: key, value: newest!);
      if (_ready) {
        for (final n in fresh.take(3)) {
          await _plugin.show(
            id: n['id'].hashCode & 0x7fffffff,
            title: n['title']?.toString() ?? 'Qline',
            body: n['body']?.toString(),
            notificationDetails: const NotificationDetails(android: _channel),
          );
        }
        if (fresh.length > 3) {
          await _plugin.show(id: 1, title: 'Qline', body: '${fresh.length - 3} more updates are waiting', notificationDetails: const NotificationDetails(android: _channel));
        }
      }
      ref.read(refreshTick.notifier).bump();
    } catch (_) {
      // Offline or signed out; try again next time.
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Unread notifications created after [seenIso], newest first.
List<Map> newAlerts(List<Map> items, String seenIso) {
  final seen = DateTime.tryParse(seenIso);
  return items.where((n) {
    if (n['read_at'] != null) return false;
    final at = DateTime.tryParse('${n['created_at']}');
    return at != null && (seen == null || at.isAfter(seen));
  }).toList();
}
