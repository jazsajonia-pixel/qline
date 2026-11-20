import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../ui/core_painter.dart';

/// Voice v2 / background continuity: what Live AI is doing right now, shared with the navbar orb so the
/// icon shows the real state while the chat is minimized (listening, thinking, speaking, idle, offline...).
@immutable
class LiveStatus {
  const LiveStatus({this.core = CoreState.idle, this.template, this.busy = false});
  final CoreState core;
  final String? template;

  /// An answer is being written, or the voice is still talking.
  final bool busy;

  @override
  bool operator ==(Object other) => other is LiveStatus && other.core == core && other.template == template && other.busy == busy;
  @override
  int get hashCode => Object.hash(core, template, busy);
}

final liveStatusProvider = NotifierProvider<LiveStatusNotifier, LiveStatus>(LiveStatusNotifier.new);

class LiveStatusNotifier extends Notifier<LiveStatus> {
  @override
  LiveStatus build() => const LiveStatus();
  void set(LiveStatus s) {
    if (s != state) state = s;
  }
}

/// The voice / mic loudness (0..1), updated up to 30 times a second. A plain notifier so only the orb repaints.
final liveLevel = ValueNotifier<double>(0);

/// The navbar orb shows a simpler set of states than the full core: idle, listening, thinking, speaking,
/// needs approval, or disconnected. "Done" settles to idle; errors and offline both read as disconnected.
CoreState navCoreState(CoreState s) => switch (s) {
      CoreState.success => CoreState.idle,
      CoreState.tool => CoreState.thinking,
      CoreState.error || CoreState.offline => CoreState.offline,
      _ => s,
    };

/// Spoken label for the navbar orb (screen readers).
String navOrbLabel(LiveStatus s, {required bool open}) {
  final st = navCoreState(s.core);
  final what = switch (st) {
    CoreState.listening => 'listening',
    CoreState.thinking => 'thinking',
    CoreState.speaking => 'speaking',
    CoreState.approval => 'needs your approval',
    CoreState.offline => 'disconnected',
    _ => 'ready',
  };
  return open ? 'Live AI, $what' : (st == CoreState.idle ? 'Open Live AI' : 'Return to Live AI, $what');
}

/// Where Live AI is shown: not opened yet, open full screen, or minimized into the navbar orb.
enum LiveView { closed, open, minimized }

@immutable
class LiveHost {
  const LiveHost({this.view = LiveView.closed, this.session = 0});
  final LiveView view;

  /// Bumped when Live AI is ended, so the next open starts a fresh screen.
  final int session;
  bool get mounted => view != LiveView.closed;
}

final liveHostProvider = NotifierProvider<LiveHostNotifier, LiveHost>(LiveHostNotifier.new);

class LiveHostNotifier extends Notifier<LiveHost> {
  @override
  LiveHost build() => const LiveHost();
  void open() => state = LiveHost(view: LiveView.open, session: state.session);
  void minimize() {
    if (state.view == LiveView.open) state = LiveHost(view: LiveView.minimized, session: state.session);
  }

  /// Stops Live AI completely (the screen is disposed: listening and speech stop; a running answer
  /// still finishes and is saved on the server).
  void end() {
    state = LiveHost(view: LiveView.closed, session: state.session + 1);
    ref.read(liveStatusProvider.notifier).set(const LiveStatus());
    liveLevel.value = 0;
  }
}
