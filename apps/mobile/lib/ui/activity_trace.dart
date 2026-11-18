import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import 'theme.dart';

/// Run 3 / M3 (docs/19): what the AI did for one answer, collapsed to a single quiet line.
///
/// Reads ("Checked your tasks") fold away. Anything that matters is never folded: actions that change
/// something (risk above L0), steps waiting for approval, failures and outcomes Qline could not confirm
/// stay visible as their own rows. The full trace stays on the server for auditing; this view never
/// shows tool arguments or results, only the summaries the server already wrote for people.

enum TraceStatus { running, completed, waiting, failed, attention }

String traceStatusLabel(TraceStatus s) => switch (s) {
  TraceStatus.running => 'Running',
  TraceStatus.completed => 'Completed',
  TraceStatus.waiting => 'Waiting for approval',
  TraceStatus.failed => 'Failed',
  TraceStatus.attention => 'Needs attention',
};

class TraceStep {
  TraceStep({this.id, required this.tool, this.summary = '', this.decision = 'allow', this.running, this.done, this.risk, this.reused = false, DateTime? started})
    : started = started ?? DateTime.now();

  /// From a live `tool.planned` event.
  factory TraceStep.planned(Map<String, dynamic> d) => TraceStep(
    id: d['stepId'] as String?,
    tool: d['tool'] as String? ?? 'tool',
    summary: d['summary'] as String? ?? '',
    decision: d['decision'] as String? ?? 'allow',
    running: d['running'] as String?,
    done: d['done'] as String?,
    risk: d['risk'] as String?,
  );

  /// From GET /runs/:id `toolCalls` (an answer loaded from history).
  factory TraceStep.fromRun(Map<String, dynamic> c) {
    final s = TraceStep(
      id: c['id'] as String?,
      tool: c['tool'] as String? ?? 'tool',
      summary: c['result_summary'] as String? ?? '',
      decision: c['status'] == 'waiting_approval' ? 'require_approval' : 'allow',
      running: c['running'] as String?,
      done: c['done'] as String?,
      risk: c['risk'] as String?,
      reused: c['reused'] == true || c['reused_context_id'] != null,
      started: DateTime.tryParse(c['created_at'] as String? ?? '')?.toLocal(),
    );
    s.finished = DateTime.tryParse(c['finished_at'] as String? ?? '')?.toLocal();
    switch (c['status']) {
      case 'succeeded':
        s.ok = true;
      case 'failed' || 'rejected' || 'cancelled' || 'blocked':
        s.ok = false;
      case 'unknown':
        s.ok = false;
        s.outcome = c['resolution'] == null ? 'unknown' : 'resolved';
    }
    return s;
  }

  final String? id;
  final String tool;
  String summary;
  final String decision;
  final String? running, done, risk;
  bool reused;
  bool? ok;

  /// 'unknown' when the action may or may not have happened.
  String? outcome;
  final DateTime started;
  DateTime? finished;

  /// Applies a live `tool.result` event.
  void result(Map<String, dynamic> d) {
    ok = d['ok'] as bool?;
    if (d['summary'] != null) summary = d['summary'] as String;
    if (d['reused'] == true) reused = true;
    outcome = d['outcome'] as String?;
    finished = DateTime.now();
  }

  TraceStatus get status {
    if (outcome == 'unknown') return TraceStatus.attention;
    if (ok == true) return TraceStatus.completed;
    if (ok == false) return TraceStatus.failed;
    if (decision == 'require_approval') return TraceStatus.waiting;
    return TraceStatus.running;
  }

  /// Plain words for the step. Older servers sent no labels: fall back to the preview title, never the id.
  String get label => switch (status) {
    TraceStatus.running || TraceStatus.waiting => running ?? (summary.isNotEmpty ? summary : 'Working'),
    _ => done ?? running ?? 'A step',
  };

  /// Changes something, or needs a person: never folded away.
  bool get important => status == TraceStatus.waiting || status == TraceStatus.failed || status == TraceStatus.attention || (risk != null && risk != 'L0');

  Duration? get took => finished?.difference(started);
}

String _took(Duration d) => d.inMilliseconds < 1000 ? '<1 s' : (d.inSeconds < 60 ? '${d.inSeconds} s' : '${d.inMinutes} min ${d.inSeconds % 60} s');

class ActivityTrace extends ConsumerStatefulWidget {
  const ActivityTrace({super.key, required this.steps, this.runId, this.onAttention});
  final List<TraceStep> steps;

  /// For answers loaded from history: the trace is fetched when the person opens it.
  final String? runId;

  /// Opens the "Needs checking" list for actions with an unknown outcome.
  final VoidCallback? onAttention;
  @override
  ConsumerState<ActivityTrace> createState() => _ActivityTraceState();
}

class _ActivityTraceState extends ConsumerState<ActivityTrace> {
  bool _open = false;
  bool _loading = false;
  String? _error;
  List<TraceStep>? _fetched;

  List<TraceStep> get _steps => widget.steps.isNotEmpty ? widget.steps : (_fetched ?? const []);

  Future<void> _fetch() async {
    if (widget.runId == null || _fetched != null || widget.steps.isNotEmpty) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await ref.read(apiProvider).get('/runs/${widget.runId}') as Map;
      _fetched = ((r['toolCalls'] as List?) ?? const []).whereType<Map>().map((c) => TraceStep.fromRun(c.cast<String, dynamic>())).toList();
    } catch (_) {
      _error = 'Could not load the steps. Try again.';
    }
    if (mounted) setState(() => _loading = false);
  }

  void _toggle() {
    setState(() => _open = !_open);
    if (_open) _fetch();
  }

  IconData _icon(TraceStatus s) => switch (s) {
    TraceStatus.completed => Icons.check_circle_outline,
    TraceStatus.failed => Icons.error_outline,
    TraceStatus.waiting => Icons.verified_user_outlined,
    TraceStatus.attention => Icons.help_outline,
    TraceStatus.running => Icons.more_horiz,
  };

  Color _color(TraceStatus s) {
    final q = context.q;
    return switch (s) {
      TraceStatus.completed => q.ok,
      TraceStatus.failed => q.bad,
      TraceStatus.waiting => q.halo,
      TraceStatus.attention => q.warn,
      TraceStatus.running => q.text2,
    };
  }

  Widget _statusIcon(TraceStatus s, {double size = 15}) =>
      s == TraceStatus.running ? SizedBox.square(dimension: size - 1, child: const CircularProgressIndicator(strokeWidth: 1.6)) : Icon(_icon(s), size: size, color: _color(s));

  /// One step, as a person reads it. [detail]: also show timing and the technical name.
  Widget _row(TraceStep s, {required bool detail}) {
    final q = context.q;
    final st = s.status;
    final summary = s.summary.isNotEmpty && s.summary != s.label ? s.summary : null;
    return Semantics(
      label: '${s.label}. ${traceStatusLabel(st)}${summary != null ? '. $summary' : ''}',
      excludeSemantics: true,
      child: InkWell(
        onTap: st == TraceStatus.attention ? widget.onAttention : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(padding: const EdgeInsets.only(top: 2), child: _statusIcon(st)),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.label,
                      style: qs(13, w: s.important ? FontWeight.w600 : FontWeight.w400, c: q.text),
                    ),
                    if (summary != null)
                      Text(
                        summary,
                        maxLines: detail ? 4 : 2,
                        overflow: TextOverflow.ellipsis,
                        style: qs(12, c: q.text2, h: 1.35),
                      ),
                    if (st != TraceStatus.completed && st != TraceStatus.running)
                      Text(st == TraceStatus.attention ? 'Needs attention · tap to check' : traceStatusLabel(st), style: qs(12, c: _color(st))),
                    if (detail)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          [if (s.reused) 'Reused from earlier', if (s.took != null) _took(s.took!), if (s.risk != null) s.risk!, s.tool].join(' · '),
                          style: qs(11, c: q.text3, family: mono),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final steps = _steps;
    final history = widget.steps.isEmpty && widget.runId != null;
    if (steps.isEmpty && !history) return const SizedBox.shrink();
    final important = _open ? const <TraceStep>[] : steps.where((s) => s.important).toList();
    final current = steps.where((s) => s.status == TraceStatus.running).lastOrNull ?? steps.lastOrNull;
    final overall = steps.isEmpty
        ? null
        : steps.any((s) => s.status == TraceStatus.attention)
        ? TraceStatus.attention
        : steps.any((s) => s.status == TraceStatus.waiting)
        ? TraceStatus.waiting
        : steps.any((s) => s.status == TraceStatus.running)
        ? TraceStatus.running
        : steps.any((s) => s.status == TraceStatus.failed)
        ? TraceStatus.failed
        : TraceStatus.completed;
    final headline = current == null ? 'What Qline did' : current.label;
    final count = steps.length > 1 ? ' · ${steps.length} steps' : '';
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            button: true,
            expanded: _open,
            label: '$headline${overall != null ? ', ${traceStatusLabel(overall)}' : ''}$count. ${_open ? 'Hide' : 'Show'} steps',
            excludeSemantics: true,
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: _toggle,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 36),
                child: Row(
                  children: [
                    if (overall != null) _statusIcon(overall, size: 14) else Icon(Icons.list_alt_outlined, size: 14, color: q.text3),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        headline,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: qs(13, c: q.text2),
                      ),
                    ),
                    Text(count, style: qs(12, c: q.text3)),
                    Icon(_open ? Icons.expand_less : Icons.expand_more, size: 16, color: q.text3),
                  ],
                ),
              ),
            ),
          ),
          for (final s in important)
            if (s != current || steps.length > 1) _row(s, detail: false),
          AnimatedSize(
            duration: const Duration(milliseconds: 160),
            alignment: Alignment.topLeft,
            child: !_open
                ? const SizedBox(width: double.infinity)
                : Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(top: 2, bottom: 4),
                    padding: const EdgeInsets.only(left: 10),
                    decoration: BoxDecoration(
                      border: Border(left: BorderSide(color: q.line, width: 2)),
                    ),
                    child: _loading
                        ? const Padding(
                            padding: EdgeInsets.all(8),
                            child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 1.6)),
                          )
                        : _error != null
                        ? TextButton(
                            onPressed: () {
                              _fetched = null;
                              _fetch();
                            },
                            child: Text(_error!),
                          )
                        : steps.isEmpty
                        ? Padding(
                            padding: const EdgeInsets.symmetric(vertical: 6),
                            child: Text('No tools were used for this answer.', style: qs(12, c: q.text3)),
                          )
                        : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final s in steps) _row(s, detail: true)]),
                  ),
          ),
        ],
      ),
    );
  }
}
