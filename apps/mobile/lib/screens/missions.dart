import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

/// v1.5 AI CEO missions (docs/13 §10): goal → CEO plan → your approval → specialist tasks.
/// Nothing runs before you approve the plan. Pause and emergency stop live at the top.
class MissionsScreen extends ConsumerStatefulWidget {
  const MissionsScreen({super.key});
  @override
  ConsumerState<MissionsScreen> createState() => _MissionsState();
}

class _MissionsState extends ConsumerState<MissionsScreen> {
  int _gen = 0;

  Future<void> _new() async {
    final goal = await promptText(context, title: 'New mission', label: 'What should the AI CEO work on?', action: 'Plan it', maxLines: 4);
    if (goal == null || goal.trim().length < 3 || !mounted) return;
    final r = await act(context, ref, (api) => api.post('/missions', {'goal': goal.trim()}), ok: 'The CEO is planning. You approve the plan before anything runs.');
    if (r is Map && mounted) {
      await push(context, MissionDetail(id: r['id'] as String));
      if (mounted) setState(() => _gen++);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Missions',
      fab: FloatingActionButton.extended(onPressed: _new, icon: const Icon(Icons.flag_outlined), label: const Text('New mission')),
      body: Load<Map>(
        key: ValueKey(_gen),
        fetch: (api) async {
          try {
            return await api.get('/missions') as Map;
          } on ApiException catch (e) {
            // An older server (before v1.5) has no missions yet: say so instead of showing an error.
            if (e.status == 404) return {'unavailable': true};
            rethrow;
          }
        },
        builder: (context, d, reload) {
          if (d['unavailable'] == true) {
            return const EmptyState(icon: Icons.cloud_sync_outlined, title: 'Missions are not on your server yet', body: 'Your Qline server needs the v1.5 update before missions and the emergency stop can be used. Everything else works as before.');
          }
          final list = items(d);
          final controls = (d['controls'] as Map?)?.cast<String, dynamic>() ?? const {};
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 96), children: [
              ControlsCard(controls: controls, onChanged: reload),
              const SizedBox(height: 8),
              if (list.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: 24),
                  child: EmptyState(icon: Icons.flag_outlined, title: 'No missions yet', body: 'Give the AI CEO a goal. It proposes a plan, you approve it, and specialist agents do the work.'),
                ),
              for (final m in list)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: QCard(
                    onTap: () async {
                      await push(context, MissionDetail(id: m['id'] as String));
                      await reload();
                    },
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: Text(m['goal'] as String? ?? '', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text))),
                        const SizedBox(width: 8),
                        StatusPill(m['status'] as String? ?? ''),
                      ]),
                      const SizedBox(height: 6),
                      Text(
                        '${(m['task_count'] ?? 0) == 0 ? 'No tasks yet' : '${m['tasks_done']}/${m['task_count']} tasks done'} · ${ago(m['created_at'] as String?)}',
                        style: qs(12, c: q.text3),
                      ),
                    ]),
                  ),
                ),
            ]),
          );
        },
      ),
    );
  }
}

/// Pause and emergency stop for the whole workspace.
class ControlsCard extends ConsumerStatefulWidget {
  const ControlsCard({super.key, required this.controls, required this.onChanged});
  final Map<String, dynamic> controls;
  final Future<void> Function() onChanged;
  @override
  ConsumerState<ControlsCard> createState() => _ControlsCardState();
}

class _ControlsCardState extends ConsumerState<ControlsCard> {
  bool _busy = false;

  Future<void> _set(Map<String, Object> change, String ok) async {
    final ws = widget.controls['workspaceId'] as String?;
    if (ws == null) return;
    setState(() => _busy = true);
    await act(context, ref, (api) => api.put('/workspaces/$ws/controls', change), ok: ok);
    if (mounted) setState(() => _busy = false);
    await widget.onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    // The server says what this person may do; the app never guesses from the role.
    final stopped = widget.controls['emergencyStop'] == true;
    final paused = widget.controls['paused'] == true;
    final canPause = widget.controls['canPause'] == true;
    final canStop = widget.controls['canStop'] == true;
    final canRelease = widget.controls['canRelease'] == true;
    return QCard(
      accent: stopped ? q.bad : (paused ? q.warn : null),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(stopped ? Icons.front_hand_outlined : (paused ? Icons.pause_circle_outline : Icons.play_circle_outline), color: stopped ? q.bad : (paused ? q.warn : q.ok)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(stopped ? 'Emergency stop is on' : (paused ? 'Missions are paused' : 'Missions can run'), style: qs(15, w: FontWeight.w600, c: q.text)),
          ),
        ]),
        const SizedBox(height: 6),
        Text(
          stopped
              ? 'No agent, workflow or mission can use any tool, and approvals are blocked, until an owner or admin turns this off.'
              : paused
                  ? 'Running tasks finish; no new tasks start.'
                  : 'Pause holds new tasks. Emergency stop halts every agent, workflow and mission at once.',
          style: qs(13, c: q.text2),
        ),
        const SizedBox(height: 12),
        Row(children: [
          if (!stopped && canPause && !paused)
            Expanded(
              child: QButton('Pause', kind: QBtn.secondary, busy: _busy, onPressed: _busy ? null : () => _set({'paused': true}, 'Paused. No new tasks will start.')),
            ),
          if (!stopped && paused && canPause)
            Expanded(child: QButton('Resume', kind: QBtn.secondary, busy: _busy, onPressed: _busy ? null : () => _set({'paused': false}, 'Resumed.'))),
          if (!stopped && canStop) ...[
            if (canPause) const SizedBox(width: 8),
            Expanded(
              child: QButton('Emergency stop', kind: QBtn.destructive, icon: Icons.front_hand_outlined, busy: _busy, onPressed: _busy
                  ? null
                  : () async {
                      final ok = await confirm(context, title: 'Emergency stop?', body: 'Every agent, workflow and mission stops using tools right away. Running mission tasks are cancelled and wait for you.', action: 'Stop everything', destructive: true);
                      if (ok) await _set({'emergencyStop': true}, 'Emergency stop is on.');
                    }),
            ),
          ],
          if (stopped && canRelease)
            Expanded(child: QButton('Turn off emergency stop', kind: QBtn.halo, busy: _busy, onPressed: _busy ? null : () => _set({'emergencyStop': false}, 'Emergency stop is off. Paused missions continue.'))),
          if (stopped && !canRelease) Expanded(child: Text('Only an owner or admin can turn it off.', style: qs(13, c: q.text3))),
        ]),
      ]),
    );
  }
}

class MissionDetail extends ConsumerStatefulWidget {
  const MissionDetail({super.key, required this.id});
  final String id;
  @override
  ConsumerState<MissionDetail> createState() => _MissionDetailState();
}

class _MissionDetailState extends ConsumerState<MissionDetail> {
  String? _busy;

  Future<void> _run(String key, Future<dynamic> Function(dynamic api) fn, String ok, Future<void> Function() reload) async {
    setState(() => _busy = key);
    await act(context, ref, (api) => fn(api), ok: ok);
    if (mounted) setState(() => _busy = null);
    await reload();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Mission',
      actions: [IconButton(tooltip: 'Trace', icon: const Icon(Icons.timeline), onPressed: () => push(context, MissionTrace(id: widget.id)))],
      body: Load<Map>(
        fetch: (api) async => await api.get('/missions/${widget.id}') as Map,
        builder: (context, m, reload) {
          final status = m['status'] as String? ?? '';
          final plan = (m['plan'] as Map?)?.cast<String, dynamic>();
          final planBody = (plan?['plan'] as Map?)?.cast<String, dynamic>();
          final planTasks = ((planBody?['tasks'] as List?) ?? const []).cast<Map>();
          final tasks = items(m, 'tasks');
          final busy = _busy != null;
          final done = ['completed', 'failed', 'cancelled', 'rejected'].contains(status);
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.all(16), children: [
              Row(children: [StatusPill(status), const Spacer(), Text(ago(m['created_at'] as String?), style: qs(12, c: q.text3))]),
              const SizedBox(height: 12),
              Text(m['goal'] as String? ?? '', style: Theme.of(context).textTheme.titleLarge),
              if (m['error'] != null) ...[const SizedBox(height: 8), Text('${m['error']}', style: qs(14, c: q.bad))],
              const SizedBox(height: 12),
              _Budget(m: m),
              if (status == 'planning') ...[
                const SizedBox(height: 16),
                QCard(child: Row(children: [const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 12), Expanded(child: Text('The CEO is writing a plan. Pull to refresh.', style: qs(14, c: q.text2)))])),
              ],
              if (plan != null) ...[
                SectionLabel('Plan · version ${plan['version']}', trailing: StatusPill(plan['status'] as String? ?? '')),
                if (planBody?['summary'] != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('${planBody!['summary']}', style: qs(14, c: q.text))),
                if (status == 'awaiting_plan_approval')
                  for (final (i, t) in planTasks.indexed) _PlanTaskCard(index: i, t: t.cast<String, dynamic>()),
              ],
              if (status == 'awaiting_plan_approval') ...[
                const SizedBox(height: 8),
                QCard(child: Text('Nothing runs until you approve. Specialists can only read your data, write notes and draft emails — they cannot send, post or change records.', style: qs(13, c: q.text2))),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(
                    child: QButton('Reject', kind: QBtn.destructive, busy: _busy == 'reject', onPressed: busy
                        ? null
                        : () => _run('reject', (api) => api.post('/missions/${widget.id}/plan/decision', {'decision': 'reject', 'planVersion': plan!['version']}), 'Plan rejected. Nothing ran.', reload)),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: QButton('Revise', kind: QBtn.secondary, busy: _busy == 'revise', onPressed: busy
                        ? null
                        : () async {
                            final note = await promptText(context, title: 'What should change?', label: 'Tell the CEO', action: 'Ask again', maxLines: 3);
                            if (note == null || note.trim().isEmpty) return;
                            await _run('revise', (api) => api.post('/missions/${widget.id}/plan/decision', {'decision': 'revise', 'planVersion': plan!['version'], 'note': note.trim()}), 'The CEO is revising the plan.', reload);
                          }),
                  ),
                ]),
                const SizedBox(height: 8),
                QButton('Approve plan', kind: QBtn.halo, icon: Icons.check, expand: true, busy: _busy == 'approve', onPressed: busy
                    ? null
                    : () => _run('approve', (api) => api.post('/missions/${widget.id}/plan/decision', {'decision': 'approve', 'planVersion': plan!['version']}), 'Approved. Tasks are starting.', reload)),
              ],
              if (tasks.isNotEmpty) ...[
                const SectionLabel('Tasks'),
                for (final t in tasks) _TaskCard(t: t, busy: _busy, run: (k, fn, ok) => _run(k, fn, ok, reload)),
              ],
              if (status == 'completed' && m['result_review'] == 'pending') ...[
                const SectionLabel('Result'),
                QCard(child: Text('All tasks finished. Check the outputs above, then accept or reject the result.', style: qs(14, c: q.text2))),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: QButton('Reject', kind: QBtn.destructive, onPressed: busy ? null : () => _run('rr', (api) => api.post('/missions/${widget.id}/result/review', {'decision': 'reject'}), 'Result rejected.', reload))),
                  const SizedBox(width: 8),
                  Expanded(child: QButton('Accept result', kind: QBtn.halo, onPressed: busy ? null : () => _run('ra', (api) => api.post('/missions/${widget.id}/result/review', {'decision': 'accept'}), 'Result accepted.', reload))),
                ]),
              ],
              if (status == 'completed' && m['result_review'] != 'pending') ...[const SectionLabel('Result'), StatusPill(m['result_review'] as String? ?? '')],
              if (!done) ...[
                const SizedBox(height: 24),
                QButton('Cancel mission', kind: QBtn.ghost, onPressed: busy
                    ? null
                    : () async {
                        final ok = await confirm(context, title: 'Cancel this mission?', body: 'Queued and running tasks stop. Finished outputs are kept.', action: 'Cancel mission', destructive: true);
                        if (ok) await _run('cancel', (api) => api.post('/missions/${widget.id}/cancel'), 'Mission cancelled.', reload);
                      }),
              ],
            ]),
          );
        },
      ),
    );
  }
}

class _Budget extends StatelessWidget {
  const _Budget({required this.m});
  final Map m;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    double frac(String spent, String budget) {
      final s = (m[spent] as num?)?.toDouble() ?? 0;
      final b = (m[budget] as num?)?.toDouble() ?? 1;
      return b <= 0 ? 0 : (s / b).clamp(0, 1).toDouble();
    }

    Widget bar(String label, double f, String text) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Text(label, style: qs(12, c: q.text3)), const Spacer(), Text(text, style: qs(12, c: q.text3, family: mono))]),
            const SizedBox(height: 4),
            ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: f, minHeight: 6, color: f > .9 ? q.bad : q.halo, backgroundColor: q.surface2)),
          ]),
        );
    return QCard(
      child: Column(children: [
        bar('AI tokens', frac('spent_tokens', 'budget_tokens'), '${m['spent_tokens']} / ${m['budget_tokens']}'),
        bar('Tool calls', frac('spent_tool_calls', 'budget_tool_calls'), '${m['spent_tool_calls']} / ${m['budget_tool_calls']}'),
      ]),
    );
  }
}

class _PlanTaskCard extends StatelessWidget {
  const _PlanTaskCard({required this.index, required this.t});
  final int index;
  final Map<String, dynamic> t;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final deps = ((t['dependsOn'] as List?) ?? const []).join(', ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: QCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${index + 1}. ${t['title']}', style: qs(14, w: FontWeight.w600, c: q.text)),
          const SizedBox(height: 4),
          Text('${cap('${t['agent']}')} agent${deps.isEmpty ? '' : ' · after $deps'}${t['review'] == 'human' ? ' · you review the output' : ''}', style: qs(12, c: q.text3)),
          const SizedBox(height: 6),
          Text('${t['instructions']}', style: qs(13, c: q.text2)),
        ]),
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.t, required this.busy, required this.run});
  final Map<String, dynamic> t;
  final String? busy;
  final Future<void> Function(String key, Future<dynamic> Function(dynamic api) fn, String ok) run;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final status = t['status'] as String? ?? '';
    final id = t['id'] as String;
    final output = t['output'];
    final b = busy != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: QCard(
        accent: status == 'review' || status == 'needs_attention' ? q.warn : null,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Expanded(child: Text('${t['title']}', style: qs(14, w: FontWeight.w600, c: q.text))), StatusPill(status)]),
          const SizedBox(height: 4),
          Text('${cap('${t['agent']}')} agent · ${t['tool_calls'] ?? 0} tool calls · ${t['tokens'] ?? 0} tokens', style: qs(12, c: q.text3)),
          if (t['error'] != null) ...[const SizedBox(height: 6), Text('${t['error']}', style: qs(13, c: q.bad))],
          if (output != null) ...[
            const SizedBox(height: 8),
            SelectableText(const JsonEncoder.withIndent('  ').convert(output), style: qs(12, c: q.text2, family: mono)),
          ],
          if (status == 'review') ...[
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: QButton('Reject', kind: QBtn.destructive, busy: busy == 'tr$id', onPressed: b ? null : () => run('tr$id', (api) => api.post('/mission-tasks/$id/review', {'decision': 'reject'}), 'Output rejected. Later tasks will not use it.'))),
              const SizedBox(width: 8),
              Expanded(child: QButton('Accept', kind: QBtn.halo, busy: busy == 'ta$id', onPressed: b ? null : () => run('ta$id', (api) => api.post('/mission-tasks/$id/review', {'decision': 'accept'}), 'Accepted. The next tasks can start.'))),
            ]),
          ],
          if (status == 'needs_attention') ...[
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: QButton('Skip', kind: QBtn.secondary, busy: busy == 'ts$id', onPressed: b ? null : () => run('ts$id', (api) => api.post('/mission-tasks/$id/resolve', {'action': 'skip'}), 'Skipped.'))),
              const SizedBox(width: 8),
              Expanded(
                child: QButton('Add budget & retry', kind: QBtn.halo, busy: busy == 'tx$id', onPressed: b
                    ? null
                    : () => run('tx$id', (api) => api.post('/mission-tasks/$id/resolve', {'action': 'retry', 'addTokens': 50000, 'addToolCalls': 20}), 'Retrying with more budget.')),
              ),
            ]),
          ],
        ]),
      ),
    );
  }
}

class MissionTrace extends StatelessWidget {
  const MissionTrace({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Trace',
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/missions/$id/trace')),
        builder: (context, list, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: list.length,
            separatorBuilder: (_, _) => Divider(color: q.line, height: 1),
            itemBuilder: (_, i) {
              final e = list[i];
              final data = e['data'] is Map ? (e['data'] as Map) : const {};
              final detail = data['key'] ?? data['tool'] ?? data['error'] ?? '';
              return ListTile(
                dense: true,
                title: Text(cap('${e['kind']}'.replaceAll('.', ' ')), style: qs(14, c: q.text)),
                subtitle: Text('${detail == '' ? '' : '$detail · '}${e['actor']} · ${ago(e['at'] as String?)}', style: qs(12, c: q.text3)),
              );
            },
          ),
        ),
      ),
    );
  }
}
