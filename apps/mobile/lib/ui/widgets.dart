import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/session.dart';
import 'theme.dart';

enum QBtn { halo, secondary, destructive, ghost }

/// Buttons. Halo is reserved for the one human-decision action on a screen.
class QButton extends StatelessWidget {
  const QButton(this.label, {super.key, required this.onPressed, this.kind = QBtn.secondary, this.icon, this.busy = false, this.expand = false});
  final String label;
  final VoidCallback? onPressed;
  final QBtn kind;
  final IconData? icon;
  final bool busy;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final (bg, fg, border) = switch (kind) {
      QBtn.halo => (q.halo, q.onHalo, q.halo),
      QBtn.secondary => (q.surface2, q.text, q.lineStrong),
      QBtn.destructive => (Colors.transparent, q.bad, q.bad),
      QBtn.ghost => (Colors.transparent, q.text2, Colors.transparent),
    };
    final disabled = onPressed == null || busy;
    final child = Row(mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
      if (busy)
        SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
      else if (icon != null)
        Icon(icon, size: 18, color: fg),
      if (busy || icon != null) const SizedBox(width: 8),
      Flexible(child: Text(label, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: fg))),
    ]);
    return Pressable(
      enabled: !disabled,
      child: Opacity(
      opacity: onPressed == null ? .45 : 1,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: disabled ? null : onPressed,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 18), child: Center(widthFactor: expand ? null : 1, child: child)),
          ),
        ),
      ),
    ),
    );
  }
}

/// Status: always icon + word, never colour alone.
class StatusPill extends StatelessWidget {
  const StatusPill(this.status, {super.key});
  final String status;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = status.toLowerCase();
    final (IconData icon, Color col, String word) = switch (s) {
      'done' || 'completed' || 'succeeded' || 'approved' || 'active' || 'confirmed' || 'ok' || 'published' || 'enabled' || 'applied' => (Icons.check_circle_outline, q.ok, _cap(s)),
      'pending' || 'awaiting_approval' || 'awaiting_plan_approval' || 'review' || 'waiting_approval' || 'queued' || 'waiting' || 'draft' || 'proposed' || 'suggested' || 'mapping' || 'uploaded' => (Icons.schedule, q.warn, _cap(s.replaceAll('_', ' '))),
      'failed' || 'dead' || 'rejected' || 'error' || 'cancelled' || 'canceled' || 'expired' || 'rolled_back' => (Icons.error_outline, q.bad, _cap(s.replaceAll('_', ' '))),
      'needs_attention' || 'unknown' => (Icons.report_outlined, q.warn, s == 'unknown' ? 'Outcome unknown' : 'Needs a check'),
      'paused' || 'blocked' || 'disabled' || 'skipped' || 'superseded' || 'archived' || 'not_configured' => (Icons.pause_circle_outline, q.text3, _cap(s.replaceAll('_', ' '))),
      'running' || 'planning' || 'ready' || 'executing' || 'in_progress' || 'open' || 'todo' => (Icons.radio_button_unchecked, q.info, _cap(s.replaceAll('_', ' '))),
      _ => (Icons.circle_outlined, q.text2, _cap(s.replaceAll('_', ' '))),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: col.withValues(alpha: .1), borderRadius: BorderRadius.circular(999), border: Border.all(color: col.withValues(alpha: .35))),
      child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 13, color: col), const SizedBox(width: 4), Text(word, style: qs(12, w: FontWeight.w600, c: col))]),
    );
  }
}

String _cap(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
String cap(String s) => _cap(s.replaceAll('_', ' '));

/// Risk label with icon.
class RiskTag extends StatelessWidget {
  const RiskTag(this.risk, {super.key});
  final String? risk;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final r = switch (risk) { 'L0' || 'L1' || null => 'low', 'L2' => 'medium', 'L3' || 'L4' => 'high', _ => risk! };
    final col = switch (r) { 'high' || 'critical' => q.bad, 'medium' => q.warn, _ => q.text2 };
    return Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.shield_outlined, size: 13, color: col), const SizedBox(width: 3), Text('${_cap(r)} risk', style: qs(12, w: FontWeight.w600, c: col))]);
  }
}

/// Where a number or fact came from.
class SourceTag extends StatelessWidget {
  const SourceTag(this.source, {super.key, this.asOf});
  final String? source;
  final String? asOf;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = source ?? 'unknown';
    final label = switch (s) {
      'workspace' || 'computed' || 'database' => 'From your data',
      'user' || 'user_entered' || 'owner' => 'You entered',
      'import' || 'imported' => 'Imported',
      'ai' || 'ai_suggested' || 'inferred' => 'AI suggestion',
      'rules' => 'Rule-based',
      'default' => 'Default',
      _ => _cap(s.replaceAll('_', ' ')),
    };
    final t = asOf == null ? '' : ' · ${ago(asOf)}';
    return Text('$label$t', style: qs(11, w: FontWeight.w500, c: q.text3, family: mono));
  }
}

String ago(String? iso) {
  if (iso == null) return '';
  final d = DateTime.tryParse(iso)?.toLocal();
  if (d == null) return '';
  final diff = DateTime.now().difference(d);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  if (diff.inDays < 7) return '${diff.inDays}d ago';
  return DateFormat.MMMd().format(d);
}

String dateLabel(String? iso) {
  if (iso == null) return '';
  final d = DateTime.tryParse(iso)?.toLocal();
  if (d == null) return '';
  return DateFormat('EEE, MMM d').format(d);
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.body, this.action});
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 40),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 52, height: 52, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: q.line), color: q.surface1), child: Icon(icon, color: q.text2)),
        const SizedBox(height: 14),
        Text(title, textAlign: TextAlign.center, style: qs(16, w: FontWeight.w600, c: q.text)),
        if (body != null) ...[const SizedBox(height: 6), Text(body!, textAlign: TextAlign.center, style: qs(14, c: q.text2))],
        if (action != null) ...[const SizedBox(height: 16), action!],
      ]),
    );
  }
}

class ErrorPanel extends StatelessWidget {
  const ErrorPanel(this.error, {super.key, this.onRetry});
  final Object error;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) {
    final msg = error is ApiException ? (error as ApiException).message : 'Something went wrong.';
    final offline = error is ApiException && (error as ApiException).isNetwork;
    return EmptyState(
      icon: offline ? Icons.cloud_off_outlined : Icons.error_outline,
      title: offline ? "You're offline" : "Couldn't load this",
      body: msg,
      action: onRetry == null ? null : QButton('Try again', icon: Icons.refresh, onPressed: onRetry),
    );
  }
}

/// Loads data from the API and rebuilds on refreshTick.
class Load<T> extends ConsumerStatefulWidget {
  const Load({super.key, required this.fetch, required this.builder, this.skeleton});
  final Future<T> Function(Api api) fetch;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;
  final Widget? skeleton;
  @override
  ConsumerState<Load<T>> createState() => _LoadState<T>();
}

class _LoadState<T> extends ConsumerState<Load<T>> {
  T? _data;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    setState(() => _loading = _data == null);
    try {
      final d = await widget.fetch(ref.read(apiProvider));
      if (mounted) {
        setState(() {
          _data = d;
          _error = null;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(refreshTick, (_, _) => _run());
    ref.listen(sessionProvider.select((s) => s.orgId), (_, _) {
      _data = null;
      _run();
    });
    if (_loading && _data == null) return widget.skeleton ?? const SkeletonList();
    if (_error != null && _data == null) return Center(child: SingleChildScrollView(child: ErrorPanel(_error!, onRetry: _run)));
    return widget.builder(context, _data as T, _run);
  }
}

class SkeletonList extends StatefulWidget {
  const SkeletonList({super.key, this.rows = 5});
  final int rows;
  @override
  State<SkeletonList> createState() => _SkeletonListState();
}

class _SkeletonListState extends State<SkeletonList> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Semantics(
      label: 'Loading',
      child: FadeTransition(
        opacity: Tween(begin: .45, end: .9).animate(_c),
        child: ListView.builder(
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          itemCount: widget.rows,
          itemBuilder: (_, i) => Container(height: 64, margin: const EdgeInsets.only(bottom: 10), decoration: BoxDecoration(color: q.surface1, borderRadius: BorderRadius.circular(14), border: Border.all(color: q.line))),
        ),
      ),
    );
  }
}

/// Bordered surface card.
class QCard extends StatelessWidget {
  const QCard({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(16), this.accent});
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;
  final Color? accent;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Pressable(
      enabled: onTap != null,
      scale: .985,
      child: Material(
        color: q.surface1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: accent ?? q.line)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
      ),
    );
  }
}

class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key, this.trailing});
  final String text;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
        child: Row(children: [
          Expanded(child: Text(text.toUpperCase(), style: qs(11, w: FontWeight.w600, c: context.q.text3, ls: 1.1))),
          ?trailing,
        ]),
      );
}

/// Small static agent orb.
class AgentOrb extends StatelessWidget {
  const AgentOrb(this.template, {super.key, this.size = 36, this.paused = false});
  final String? template;
  final double size;
  final bool paused;
  @override
  Widget build(BuildContext context) {
    final hue = paused ? context.q.text3 : AgentStyle.of(template).hue;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(colors: [Colors.white.withValues(alpha: .85), hue.withValues(alpha: .6), const Color(0xFF080A12)], stops: const [0, .35, 1]),
        border: Border.all(color: hue.withValues(alpha: .8), width: 1.4),
      ),
    );
  }
}

void toast(BuildContext context, String msg) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(msg)));
}

void toastError(BuildContext context, Object e) => toast(context, e is ApiException ? e.message : 'Something went wrong.');

Future<bool> confirm(BuildContext context, {required String title, required String body, required String action, bool destructive = false}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title, style: qs(18, w: FontWeight.w600, c: ctx.q.text)),
      content: Text(body, style: qs(14, c: ctx.q.text2)),
      actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      actions: [
        QButton('Cancel', kind: QBtn.ghost, onPressed: () => Navigator.pop(ctx, false)),
        QButton(action, kind: destructive ? QBtn.destructive : QBtn.halo, onPressed: () => Navigator.pop(ctx, true)),
      ],
    ),
  );
  return r ?? false;
}

/// Prompt for a single text value.
Future<String?> promptText(BuildContext context, {required String title, String? label, String? initial, String action = 'Save', int maxLines = 1}) {
  final c = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title, style: qs(18, w: FontWeight.w600, c: ctx.q.text)),
      content: TextField(controller: c, autofocus: true, maxLines: maxLines, minLines: 1, decoration: InputDecoration(labelText: label)),
      actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      actions: [
        QButton('Cancel', kind: QBtn.ghost, onPressed: () => Navigator.pop(ctx)),
        QButton(action, kind: QBtn.halo, onPressed: () => Navigator.pop(ctx, c.text.trim())),
      ],
    ),
  );
}

/// Run an API action with a toast on failure; bumps refreshTick on success.
Future<T?> act<T>(BuildContext context, WidgetRef ref, Future<T> Function(Api api) fn, {String? ok}) async {
  try {
    final r = await fn(ref.read(apiProvider));
    ref.read(refreshTick.notifier).bump();
    if (ok != null && context.mounted) toast(context, ok);
    return r;
  } catch (e) {
    if (context.mounted) toastError(context, e);
    return null;
  }
}

List<Map<String, dynamic>> items(dynamic r, [String key = 'items']) => ((r is Map ? r[key] : r) as List? ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();

Future<T?> push<T>(BuildContext context, Widget page) => Navigator.of(context).push<T>(MaterialPageRoute(builder: (_) => page));

/// Standard page scaffold for pushed screens.
class Page2 extends StatelessWidget {
  const Page2({super.key, required this.title, required this.body, this.actions, this.fab});
  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? fab;
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(title), actions: actions), body: SafeArea(top: false, child: body), floatingActionButton: fab);
}

class KV extends StatelessWidget {
  const KV(this.k, this.v, {super.key});
  final String k;
  final String v;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 120, child: Text(k, style: qs(13, c: context.q.text3))),
          Expanded(child: Text(v, style: qs(14, c: context.q.text))),
        ]),
      );
}

bool motionOff(BuildContext context, WidgetRef? ref) => MediaQuery.of(context).disableAnimations || (ref?.read(prefsProvider).reduceMotion ?? false);

/// Subtle press-down scale. Listens to raw pointer events so it never steals taps.
class Pressable extends ConsumerStatefulWidget {
  const Pressable({super.key, required this.child, this.enabled = true, this.scale = .97});
  final Widget child;
  final bool enabled;
  final double scale;
  @override
  ConsumerState<Pressable> createState() => _PressableState();
}

class _PressableState extends ConsumerState<Pressable> {
  bool _down = false;
  void _set(bool v) {
    if (widget.enabled && _down != v) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    final off = MediaQuery.of(context).disableAnimations || ref.watch(prefsProvider).reduceMotion;
    return Listener(
      onPointerDown: (_) => _set(true),
      onPointerUp: (_) => _set(false),
      onPointerCancel: (_) => _set(false),
      child: AnimatedScale(scale: _down && !off ? widget.scale : 1, duration: const Duration(milliseconds: 110), curve: Curves.easeOut, child: widget.child),
    );
  }
}

/// Staggered entrance: fade + 12px rise, 40ms per index (capped). Static when motion is reduced.
class Reveal extends ConsumerStatefulWidget {
  const Reveal({super.key, required this.child, this.index = 0});
  final Widget child;
  final int index;
  @override
  ConsumerState<Reveal> createState() => _RevealState();
}

class _RevealState extends ConsumerState<Reveal> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 360));
  Timer? _t;
  bool _started = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (MediaQuery.of(context).disableAnimations || ref.read(prefsProvider).reduceMotion) {
      _c.value = 1;
      return;
    }
    _t = Timer(Duration(milliseconds: 40 * widget.index.clamp(0, 8)), () {
      if (mounted) _c.forward();
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.of(context).disableAnimations || ref.watch(prefsProvider).reduceMotion) return widget.child;
    final a = CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);
    return AnimatedBuilder(
      animation: a,
      builder: (_, child) => Opacity(opacity: a.value, child: Transform.translate(offset: Offset(0, 12 * (1 - a.value)), child: child)),
      child: widget.child,
    );
  }
}

/// Lead urgency: icon + word, never colour alone.
class UrgencyPill extends StatelessWidget {
  const UrgencyPill(this.urgency, {super.key});
  final String? urgency;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final (IconData icon, Color col, String word) = switch (urgency) {
      'urgent' => (Icons.local_fire_department, q.bad, 'Urgent'),
      'high' => (Icons.trending_up, q.warn, 'Hot'),
      'normal' => (Icons.circle_outlined, q.info, 'Normal'),
      _ => (Icons.remove, q.text3, 'Low'),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: col.withValues(alpha: .1), borderRadius: BorderRadius.circular(999), border: Border.all(color: col.withValues(alpha: .4))),
      child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 13, color: col), const SizedBox(width: 4), Text(word, style: qs(12, w: FontWeight.w600, c: col))]),
    );
  }
}
