// Port of docs/prototype/core.js — the agent energy core.
import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:material_ui/material_ui.dart';

import 'theme.dart';

enum CoreState { idle, listening, thinking, tool, approval, speaking, success, error, offline }

const _ivory = Color(0xFFE9E4F5), _halo = Color(0xFF5EF2C6), _amber = Color(0xFFB79BFF), _bad = Color(0xFFFF7A8A), _grey = Color(0xFF7E7894);

class _P {
  _P(this.glow, this.scale, this.ring, this.ringW, this.halo, this.sSpeed, this.sAlpha, this.conv, this.dash, this.sats, this.notch, this.err, this.wave, this.amp, this.desat, this.cross);
  double glow, scale, ringW, halo, sSpeed, sAlpha, conv, dash, sats, notch, err, wave, amp, desat, cross;
  Color ring;
  _P clone() => _P(glow, scale, ring, ringW, halo, sSpeed, sAlpha, conv, dash, sats, notch, err, wave, amp, desat, cross);
  void towards(_P t, double k) {
    double l(double a, double b) => a + (b - a) * k;
    glow = l(glow, t.glow); scale = l(scale, t.scale); ringW = l(ringW, t.ringW); halo = l(halo, t.halo);
    sSpeed = l(sSpeed, t.sSpeed); sAlpha = l(sAlpha, t.sAlpha); conv = l(conv, t.conv); dash = l(dash, t.dash);
    sats = l(sats, t.sats); notch = l(notch, t.notch); err = l(err, t.err); wave = l(wave, t.wave);
    amp = l(amp, t.amp); desat = l(desat, t.desat); cross = l(cross, t.cross);
    ring = Color.lerp(ring, t.ring, k)!;
  }
}

final _states = <CoreState, _P>{
  CoreState.idle: _P(.75, 1.0, _ivory, 1.6, .18, 1.0, .32, 0, 0, 0, 0, 0, 0, 0, 0, .25),
  CoreState.listening: _P(1.0, 1.08, _ivory, 1.8, .42, .6, .28, 0, 0, 0, 0, 0, 0, 1, 0, .15),
  CoreState.thinking: _P(.9, .94, _ivory, 1.6, .2, 2.4, .42, 1, 1, 0, 0, 0, 0, 0, 0, .7),
  CoreState.tool: _P(.85, 1.0, _amber, 2.2, .26, 1.6, .36, .5, 1, 2, 0, 0, 0, 0, 0, .85),
  CoreState.approval: _P(.5, .96, _halo, 2.6, .3, .15, .18, 0, 0, 0, 1, 0, 0, 0, 0, .1),
  CoreState.speaking: _P(1.0, 1.04, _ivory, 1.8, .3, 1.1, .34, 0, 0, 0, 0, 0, 1, 1, 0, .3),
  CoreState.success: _P(1.25, 1.02, _ivory, 1.8, .34, .8, .3, 0, 0, 0, 0, 0, 0, 0, 0, .2),
  CoreState.error: _P(.35, .92, _grey, 1.4, .08, .35, .16, 0, 0, 0, 0, 1, 0, 0, .75, .05),
  CoreState.offline: _P(.2, .9, _grey, 1.2, 0, 0, .08, 0, 1, 0, 0, 0, 0, 0, 1, 0),
};

String coreLabel(CoreState s) => switch (s) {
      CoreState.idle => 'Ready',
      CoreState.listening => 'Listening',
      CoreState.thinking => 'Thinking',
      CoreState.tool => 'Working',
      CoreState.approval => 'Needs your approval',
      CoreState.speaking => 'Speaking',
      CoreState.success => 'Done',
      CoreState.error => 'Something went wrong',
      CoreState.offline => 'Offline',
    };

class _Rand {
  _Rand(this.s);
  int s;
  double call() => (s = (s * 16807) % 2147483647) / 2147483647;
}

class _Model {
  _Model() {
    final r = _Rand(7);
    stars = List.generate(60, (_) => [r(), r(), r() * 1.2 + .3, r() * 6.28]);
    parts = List.generate(140, (_) => [r() * 6.283, math.pow(r(), 1.8).toDouble(), r() * 6.28, r() * 1.3 + .6]);
    strands = List.generate(7, (i) => [1.25 + r() * .7, 1.0 + r() * .7, r() * 6.28, r() * 6.28, (r() * .6 + .4) * (i.isOdd ? 1 : -1), .35 + r() * .35, i % 3 == 0 ? 1 : 0]);
  }
  late final List<List<double>> stars, parts, strands;
  _P p = _states[CoreState.idle]!.clone();
  Color hue = AgentStyle.of('ceo').hue;
  double t = 0, flash = 0;
}

/// Animated energy core. Purely decorative: wrapped in a Semantics label of the state.
class EnergyCore extends StatefulWidget {
  const EnergyCore({super.key, required this.state, this.agent = 'ceo', this.reduceMotion = false, this.compact = false, this.level = 0, this.background = true});
  final CoreState state;
  final String agent;
  final bool reduceMotion;
  final bool compact;
  final bool background;
  /// Real microphone level 0..1 when listening (from speech_to_text). 0 → gentle synthetic pulse.
  final double level;
  @override
  State<EnergyCore> createState() => _EnergyCoreState();
}

class _EnergyCoreState extends State<EnergyCore> with SingleTickerProviderStateMixin {
  final _m = _Model();
  late final Ticker _ticker;
  Duration _last = Duration.zero;
  final _repaint = ValueNotifier<int>(0);

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick);
    // MediaQuery can't be read here; didChangeDependencies runs next and starts/stops the ticker.
    _m.p = _states[widget.state]!.clone();
    _m.hue = AgentStyle.of(widget.agent).hue;
  }

  void _apply() {
    if (widget.reduceMotion) {
      _m.p = _states[widget.state]!.clone();
      _m.hue = AgentStyle.of(widget.agent).hue;
    }
    if (widget.reduceMotion || MediaQuery.maybeDisableAnimationsOf(context) == true) {
      _ticker.stop();
      _m.p = _states[widget.state]!.clone();
      _repaint.value++;
    } else if (!_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _apply();
  }

  @override
  void didUpdateWidget(EnergyCore old) {
    super.didUpdateWidget(old);
    if (widget.state == CoreState.success && old.state != CoreState.success) _m.flash = 1;
    _apply();
  }

  void _tick(Duration now) {
    final dt = _last == Duration.zero ? 0.016 : math.min(.05, (now - _last).inMicroseconds / 1e6);
    _last = now;
    final ag = AgentStyle.of(widget.agent);
    _m.t += dt * ag.speed;
    final k = math.min(1.0, dt * 2.6);
    _m.p.towards(_states[widget.state]!, k);
    _m.hue = Color.lerp(_m.hue, ag.hue, k)!;
    _m.flash = math.max(0, _m.flash - dt * 2.5);
    _repaint.value++;
  }

  @override
  void dispose() {
    _ticker.dispose();
    _repaint.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Assistant status: ${coreLabel(widget.state)}',
        child: RepaintBoundary(
          child: CustomPaint(
            painter: _CorePainter(_m, _repaint, widget.agent, widget.compact, widget.level, widget.state, widget.background),
            size: Size.infinite,
          ),
        ),
      );
}

Color _rgba(Color c, double a) => c.withValues(alpha: a.clamp(0, 1).toDouble());
Color _mix(Color a, Color b, double t) => Color.lerp(a, b, t)!;

class _CorePainter extends CustomPainter {
  _CorePainter(this.m, Listenable repaint, this.agent, this.compact, this.level, this.state, this.background) : super(repaint: repaint);
  final _Model m;
  final String agent;
  final bool compact, background;
  final double level;
  final CoreState state;

  @override
  void paint(Canvas c, Size size) {
    final w = size.width, h = size.height;
    final p = m.p, t = m.t, ag = AgentStyle.of(agent);
    final hue = _mix(m.hue, const Color(0xFF969EA8), p.desat);
    final cx = w / 2, cy = h * .5, R = math.min(w, h) * (compact ? .3 : .22);
    final synth = .35 + .35 * math.sin(t * 7.3) * math.sin(t * 2.1) + .3 * math.sin(t * 13.7).abs();
    final micAmp = p.amp * (level > 0 ? level : synth);
    final ctr = Offset(cx, cy);
    final paint = Paint();

    if (background) {
      c.drawRect(Offset.zero & size, paint..color = const Color(0xFF07060D));
      paint.shader = RadialGradient(colors: [_rgba(hue, .16 * p.glow), _rgba(hue, .05 * p.glow), const Color(0x0007060D)], stops: const [0, .5, 1])
          .createShader(Rect.fromCircle(center: ctr, radius: R * 3.4));
      c.drawRect(Offset.zero & size, paint);
      paint.shader = null;
      for (final s in m.stars) {
        final a = .25 + .25 * math.sin(t * 1.3 + s[3]);
        c.drawRect(Rect.fromLTWH(s[0] * w, s[1] * h, s[2], s[2]), paint..color = Color.fromRGBO(200, 215, 230, a * .55));
      }
    }
    final add = Paint()..blendMode = BlendMode.plus..style = PaintingStyle.stroke;
    if (p.cross > .01 && background) {
      for (var j = 0; j < 2; j++) {
        final col = j == 1 ? hue : _amber;
        final path = Path();
        for (double y = -20; y <= h + 20; y += 8) {
          final x = cx + math.sin(y * .012 + t * (j == 1 ? 1.3 : -1.1) + j * 2) * R * (.35 + .25 * j) + math.sin(y * .03 + t) * 4;
          y == -20 ? path.moveTo(x, y) : path.lineTo(x, y);
        }
        add
          ..strokeWidth = 1.4
          ..shader = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [_rgba(col, 0), _rgba(col, .5 * p.cross), _rgba(col, .05), _rgba(col, .45 * p.cross), _rgba(col, 0)], stops: const [0, .3, .5, .7, 1])
              .createShader(Rect.fromLTWH(0, 0, w, h));
        c.drawPath(path, add);
      }
      add.shader = null;
    }
    add.strokeWidth = 1.1;
    for (final s in m.strands) {
      final col = s[6] == 1 ? _mix(_ivory, _amber, .5) : _mix(hue, _ivory, .25);
      final rot = s[3] + t * .15 * s[4] * p.sSpeed;
      final start = s[2] + t * .5 * s[4] * p.sSpeed;
      const n = 36;
      Offset pt(double u) {
        final wob = 1 + math.sin(u * 3 + t * 1.5) * .05 * ag.curl * (1 + p.sSpeed * .3) + p.halo * .25;
        final x = math.cos(u) * R * s[0] * wob, y = math.sin(u) * R * s[1] * wob;
        return Offset(cx + x * math.cos(rot) - y * math.sin(rot), cy + x * math.sin(rot) + y * math.cos(rot));
      }
      for (var i = 0; i < n - 1; i++) {
        final u0 = start + (i / n) * s[5] * 6.283, u1 = start + ((i + 1) / n) * s[5] * 6.283;
        add.color = _rgba(col, p.sAlpha * math.sin((i / n) * math.pi));
        c.drawLine(pt(u0), pt(u1), add);
      }
    }
    final ringC = p.ring;
    final haloR = R * (1.0 + p.halo * .9 + micAmp * .12);
    paint.shader = RadialGradient(colors: [_rgba(ringC, 0), _rgba(ringC, .10 * (p.halo * 2 + .2)), _rgba(ringC, 0)], stops: [(R * .95) / (haloR + R * .35), .25 + .75 * (R * .95) / (haloR + R * .35), 1])
        .createShader(Rect.fromCircle(center: ctr, radius: haloR + R * .35));
    c.drawCircle(ctr, haloR + R * .35, paint);
    paint.shader = null;
    if (p.halo > .3) {
      c.drawCircle(ctr, R * (1.28 + micAmp * .05), Paint()..style = PaintingStyle.stroke..strokeWidth = 1..color = _rgba(ringC, .18 * p.halo));
    }
    final sc = p.scale * (1 + micAmp * .06);
    paint.shader = RadialGradient(colors: [_rgba(_mix(hue, Colors.white, .3), .55 * p.glow), _rgba(_mix(hue, const Color(0xFF0A0C14), .55), .55), const Color(0xF5080A12)], stops: const [0, .45, 1])
        .createShader(Rect.fromCircle(center: ctr, radius: R));
    c.drawCircle(ctr, R, paint);
    paint.shader = null;
    // inner orbit, dashed when thinking/working
    final orbit = Paint()..style = PaintingStyle.stroke..strokeWidth = 1..color = _rgba(_mix(hue, _ivory, .4), .32);
    if (p.dash > .5) {
      const segs = 16;
      final off = t * 40 / (R * .64);
      for (var i = 0; i < segs; i++) {
        final a0 = off + i * 6.283 / segs;
        c.drawArc(Rect.fromCircle(center: ctr, radius: R * .64), a0, 6.283 / segs * .57, false, orbit);
      }
    } else {
      c.drawCircle(ctr, R * .64, orbit);
    }
    final breath = 1 + math.sin(t * 1.6) * .04;
    final dot = Paint()..blendMode = BlendMode.plus;
    for (final q in m.parts) {
      final d = q[1] * R * .55 * sc * breath * (1 - p.conv * .45 * (.5 + .5 * math.sin(t * 3 + q[2])));
      final a = q[0] + t * .25 * (1 + p.conv);
      final al = (.25 + .55 * (1 - q[1])) * p.glow * (.6 + .4 * math.sin(t * 4 + q[2]));
      dot.color = _rgba(q[1] < .3 ? Colors.white : _mix(hue, Colors.white, .35), math.max(0, al));
      c.drawRect(Rect.fromLTWH(cx + math.cos(a) * d, cy + math.sin(a) * d, q[3], q[3]), dot);
    }
    dot.shader = RadialGradient(colors: [_rgba(Colors.white, .9 * math.min(1, p.glow + m.flash)), _rgba(_mix(hue, Colors.white, .5), .45 * p.glow), _rgba(hue, 0)], stops: const [0, .25, 1])
        .createShader(Rect.fromCircle(center: ctr, radius: R * .42 * sc));
    c.drawCircle(ctr, R * .42 * sc, dot);
    dot.shader = null;
    if (m.flash > 0) c.drawCircle(ctr, R * 1.6, dot..color = _rgba(_ivory, .12 * m.flash));
    // main ring
    final gap = p.notch * .14;
    final startA = -math.pi / 2 + gap, sweep = 6.283 - 2 * gap;
    final ringPath = Path();
    if (p.wave > .02) {
      for (var i = 0; i <= 120; i++) {
        final a = startA + sweep * i / 120;
        final rr = R * (1 + p.wave * .022 * math.sin(a * 9 + t * 9) * (.6 + .4 * math.sin(t * 5.1)));
        final o = Offset(cx + math.cos(a) * rr, cy + math.sin(a) * rr);
        i == 0 ? ringPath.moveTo(o.dx, o.dy) : ringPath.lineTo(o.dx, o.dy);
      }
    } else {
      ringPath.addArc(Rect.fromCircle(center: ctr, radius: R), startA, sweep);
    }
    c.drawPath(ringPath, Paint()..style = PaintingStyle.stroke..strokeWidth = p.ringW + 4..color = _rgba(ringC, .35)..maskFilter = MaskFilter.blur(BlurStyle.normal, 7 + p.halo * 8));
    c.drawPath(ringPath, Paint()..style = PaintingStyle.stroke..strokeWidth = p.ringW..color = _rgba(ringC, .95));
    if (p.notch > .3) {
      c.drawLine(Offset(cx, cy - R - 6), Offset(cx, cy - R - 16), Paint()..strokeWidth = 2..color = _rgba(_halo, p.notch));
    }
    if (p.err > .05) {
      c.drawArc(Rect.fromCircle(center: ctr, radius: R), -.55, .7, false, Paint()..style = PaintingStyle.stroke..strokeWidth = 2.4..color = _rgba(_bad, .9 * p.err));
    }
    if (p.sats > .05) {
      for (var i = 0; i < 2; i++) {
        final a = t * 1.6 + i * math.pi;
        final o = Offset(cx + math.cos(a) * R * 1.13, cy + math.sin(a) * R * 1.13);
        c.drawCircle(o, 8, Paint()..color = _rgba(_amber, .15 * p.sats / 2));
        c.drawCircle(o, 3, Paint()..color = _rgba(_amber, p.sats / 2));
      }
    }
  }

  @override
  bool shouldRepaint(_CorePainter old) => old.agent != agent || old.state != state || old.level != level;
}

/// The Qline mark: a ring with a short tail — the "Q-line".
class QMark extends StatelessWidget {
  const QMark({super.key, this.size = 28, this.color});
  final double size;
  final Color? color;
  @override
  Widget build(BuildContext context) => CustomPaint(size: Size.square(size), painter: _QMarkPainter(color ?? context.q.halo));
}

class _QMarkPainter extends CustomPainter {
  _QMarkPainter(this.color);
  final Color color;
  @override
  void paint(Canvas c, Size s) {
    final r = s.width * .36;
    final ctr = Offset(s.width * .46, s.height * .46);
    final p = Paint()..style = PaintingStyle.stroke..strokeWidth = s.width * .1..strokeCap = StrokeCap.round..color = color;
    c.drawArc(Rect.fromCircle(center: ctr, radius: r), .9, 5.6, false, p);
    c.drawLine(ctr + Offset(r * .35, r * .35), Offset(s.width * .92, s.height * .92), p);
  }

  @override
  bool shouldRepaint(_QMarkPainter o) => o.color != color;
}
