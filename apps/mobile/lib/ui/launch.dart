import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'core_painter.dart';
import 'theme.dart';

/// How long the launch animation plays on every cold start.
const launchDuration = Duration(seconds: 5);

/// Launch screen: the energy core wakes up, cycles through its working states, and settles
/// as the progress line completes. Always dark, like Live AI.
class LaunchScreen extends StatefulWidget {
  const LaunchScreen({super.key, this.duration = launchDuration});
  final Duration duration;
  @override
  State<LaunchScreen> createState() => _LaunchScreenState();
}

class _Phase {
  const _Phase(this.at, this.state, this.line);
  final double at; // 0..1 of the duration
  final CoreState state;
  final String line;
}

const _phases = [
  _Phase(0, CoreState.listening, 'Waking up'),
  _Phase(.28, CoreState.thinking, 'Loading your workspace'),
  _Phase(.56, CoreState.tool, 'Checking connected apps'),
  _Phase(.84, CoreState.success, 'Ready'),
];

class _LaunchScreenState extends State<LaunchScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: widget.duration)..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return Theme(
      data: buildTheme(false),
      child: Builder(builder: (context) {
        final q = context.q;
        return Scaffold(
          backgroundColor: const Color(0xFF07060D),
          body: AnimatedBuilder(
            animation: _c,
            builder: (context, _) {
              final v = _c.value;
              final phase = _phases.lastWhere((p) => v >= p.at);
              final fadeIn = Curves.easeOutCubic.transform((v / .18).clamp(0, 1).toDouble());
              return Stack(children: [
                Positioned.fill(child: ExcludeSemantics(child: EnergyCore(state: phase.state, reduceMotion: reduce))),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 72,
                  child: Opacity(
                    opacity: reduce ? 1 : fadeIn,
                    child: Column(children: [
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        QMark(size: 26, color: q.halo),
                        const SizedBox(width: 10),
                        Text('Qline', style: qs(26, w: FontWeight.w700, c: q.text, ls: -.4)),
                      ]),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: 168,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(2),
                          child: LinearProgressIndicator(
                            value: v,
                            minHeight: 2,
                            backgroundColor: q.text.withValues(alpha: .1),
                            valueColor: AlwaysStoppedAnimation(q.halo),
                            semanticsLabel: 'Starting Qline',
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      AnimatedSwitcher(
                        duration: reduce ? Duration.zero : const Duration(milliseconds: 260),
                        child: Text(phase.line, key: ValueKey(phase.line), style: qs(12, c: q.text2, family: mono, ls: .6)),
                      ),
                    ]),
                  ),
                ),
              ]);
            },
          ),
        );
      }),
    );
  }
}

/// Completes after [launchDuration]; the app shows [LaunchScreen] until then (and until the session loads).
class LaunchGate {
  LaunchGate([Duration d = launchDuration]) {
    _t = Timer(d, () {
      done = true;
      for (final l in _ls) {
        l();
      }
    });
  }
  late final Timer _t;
  bool done = false;
  final _ls = <VoidCallback>[];
  void listen(VoidCallback l) => _ls.add(l);
  void dispose() => _t.cancel();
}
