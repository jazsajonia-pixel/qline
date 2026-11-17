import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'approvals.dart';
import 'workflows.dart' show stepIcon;

/// Supervised operations (M5): what the automations are doing, what needs a person, and what went wrong.
/// Every control here maps to one permission-checked API call; the server is the source of truth for what is allowed.

/// Plain-language meaning of a run state. The pill shows the word; this line says what it means for the person.
String runStateLine(String status) => switch (status) {
      'queued' => 'Waiting for the worker to pick it up.',
      'running' => 'Working through its steps.',
      'waiting_approval' => 'Paused until someone approves the next step.',
      'needs_attention' => 'Stopped. A person needs to check it before it continues.',
      'completed' => 'Finished.',
      'failed' => 'Stopped with an error. Nothing after the failed step ran.',
      'rejected' => 'Someone said no, so it stopped.',
      'cancelled' => 'Cancelled by a person. Steps already done stay done.',
      _ => cap(status),
    };

String jobKindLabel(String kind) => switch (kind) {
      'workflow.advance' => 'Workflow step',
      'workflow.scheduled' => 'Scheduled workflow',
      'event.dispatch' => 'Event trigger',
      'integration.sync' => 'Integration sync',
      _ => kind,
    };

String toolLabel(String tool) => switch (tool) {
      'slack.post' => 'Slack post',
      'gmail.send' || 'email.send' => 'Email',
      'calendar.create' => 'Calendar event',
      _ => cap(tool.replaceAll('.', ' ')),
    };

/// Compact status strip for the Workflows screen: counts that open the matching run view.
class OpsStrip extends ConsumerWidget {
  const OpsStrip({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canManage = ref.watch(sessionProvider.select((s) => s.role != 'viewer' && s.role != 'member'));
    return Load<Map>(
      fetch: (api) async => await api.get('/workflow-runs', {'view': 'needs_you', 'limit': 1}) as Map,
      skeleton: const SizedBox(height: 64),
      builder: (context, r, _) {
        final c = (r['counts'] as Map?) ?? const {};
        final needs = (c['needs_you'] as num?)?.toInt() ?? 0;
        final active = (c['active'] as num?)?.toInt() ?? 0;
        final failed = (c['failed_7d'] as num?)?.toInt() ?? 0;
        Widget cell(String label, int n, Color col, String view) => Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () => push(context, RunsScreen(initialView: view)),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('$n', style: qs(22, w: FontWeight.w600, c: n > 0 ? col : q.text3, family: mono)),
                    const SizedBox(height: 2),
                    Text(label, style: qs(12, c: q.text2)),
                  ]),
                ),
              ),
            );
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SectionLabel('Operations', trailing: canManage ? TextButton(onPressed: () => push(context, const JobsScreen()), child: Text('Background jobs', style: qs(13, w: FontWeight.w600, c: q.text2))) : null),
          QCard(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            accent: needs > 0 ? q.halo.withValues(alpha: .45) : null,
            child: Row(children: [
              cell('Need you', needs, q.halo, 'needs_you'),
              Container(width: 1, height: 36, color: q.line),
              cell('Running', active, q.info, 'active'),
              Container(width: 1, height: 36, color: q.line),
              cell('Failed (7 days)', failed, q.bad, 'failed'),
            ]),
          ),
        ]);
      },
    );
  }
}

/// Execution history across all workflows, filtered by what the runs need.
class RunsScreen extends StatefulWidget {
  const RunsScreen({super.key, this.initialView = 'needs_you', this.workflowId});
  final String initialView;
  final String? workflowId;
  @override
  State<RunsScreen> createState() => _RunsScreenState();
}

class _RunsScreenState extends State<RunsScreen> {
  late String _view = widget.initialView;
  static const _views = {'needs_you': 'Need you', 'active': 'Running', 'failed': 'Failed', 'all': 'All'};

  @override
  Widget build(BuildContext context) {
    return Page2(
      title: 'Runs',
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SegmentedButton<String>(
              showSelectedIcon: false,
              segments: [for (final e in _views.entries) ButtonSegment(value: e.key, label: Text(e.value))],
              selected: {_view},
              onSelectionChanged: (s) => setState(() => _view = s.first),
            ),
          ),
        ),
        Expanded(child: _RunList(key: ValueKey(_view), view: _view, workflowId: widget.workflowId)),
      ]),
    );
  }
}

class _RunList extends ConsumerStatefulWidget {
  const _RunList({super.key, required this.view, this.workflowId});
  final String view;
  final String? workflowId;
  @override
  ConsumerState<_RunList> createState() => _RunListState();
}

class _RunListState extends ConsumerState<_RunList> {
  final _older = <Map<String, dynamic>>[];
  bool _more = true;
  bool _loadingMore = false;
  static const _page = 30;

  Future<void> _loadOlder(String? before) async {
    if (before == null) return;
    setState(() => _loadingMore = true);
    try {
      final r = await ref.read(apiProvider).get('/workflow-runs', {'view': widget.view, 'workflowId': widget.workflowId, 'before': before, 'limit': _page});
      final got = items(r);
      setState(() {
        _older.addAll(got);
        _more = got.length == _page;
      });
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Load<List<Map<String, dynamic>>>(
      fetch: (api) async {
        _older.clear();
        _more = true;
        final r = items(await api.get('/workflow-runs', {'view': widget.view, 'workflowId': widget.workflowId, 'limit': _page}));
        _more = r.length == _page;
        return r;
      },
      builder: (context, first, reload) {
        final list = [...first, ..._older];
        if (list.isEmpty) {
          final (icon, title, body) = switch (widget.view) {
            'needs_you' => (Icons.verified_user_outlined, 'Nothing needs you', 'Runs waiting for an approval or a check show up here.'),
            'active' => (Icons.hourglass_empty, 'Nothing running', 'Runs appear here while the worker is on them.'),
            'failed' => (Icons.check_circle_outline, 'No failed runs', 'Runs that stop with an error show up here.'),
            _ => (Icons.history, 'No runs yet', 'Turn on or run a workflow and its history appears here.'),
          };
          return RefreshIndicator(onRefresh: reload, child: ListView(children: [EmptyState(icon: icon, title: title, body: body)]));
        }
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
            itemCount: list.length + (_more ? 1 : 0),
            separatorBuilder: (_, _) => const SizedBox(height: 8),
            itemBuilder: (context, i) {
              if (i == list.length) {
                return Center(child: QButton('Load older', kind: QBtn.ghost, busy: _loadingMore, onPressed: () => _loadOlder(list.last['started_at'] as String?)));
              }
              return RunTile(run: list[i], onReturn: reload);
            },
          ),
        );
      },
    );
  }
}

class RunTile extends StatelessWidget {
  const RunTile({super.key, required this.run, this.onReturn, this.showWorkflow = true});
  final Map<String, dynamic> run;
  final Future<void> Function()? onReturn;
  final bool showWorkflow;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final status = run['status'] as String;
    final unknown = run['outcome_unknown'] == true;
    final hint = switch (status) {
      'waiting_approval' => 'Waiting for approval',
      'needs_attention' => unknown ? 'An action may or may not have happened' : 'Stopped after retries',
      _ => null,
    };
    return QCard(
      accent: status == 'needs_attention' ? q.warn.withValues(alpha: .5) : null,
      onTap: () async {
        await push(context, WorkflowRunDetail(id: run['id'] as String));
        await onReturn?.call();
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(showWorkflow ? (run['workflow_name'] as String? ?? 'Workflow') : '${cap(run['trigger_kind'] as String? ?? 'run')} run', style: qs(15, w: FontWeight.w600, c: q.text), overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 8),
          StatusPill(status),
        ]),
        const SizedBox(height: 4),
        Text('${run['dry_run'] == true ? 'Dry run' : cap(run['trigger_kind'] as String? ?? 'run')} · started ${ago(run['started_at'] as String?)}', style: qs(12, c: q.text3)),
        if (hint != null) ...[
          const SizedBox(height: 6),
          Row(children: [Icon(status == 'waiting_approval' ? Icons.verified_user_outlined : Icons.report_outlined, size: 14, color: status == 'waiting_approval' ? q.halo : q.warn), const SizedBox(width: 6), Flexible(child: Text(hint, style: qs(13, c: q.text2)))]),
        ] else if (run['error'] != null) ...[
          const SizedBox(height: 6),
          Text(run['error'] as String, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: q.bad)),
        ],
      ]),
    );
  }
}

/// One run: state, what it needs, its approvals, external actions, steps and (for managers) its jobs.
class WorkflowRunDetail extends ConsumerWidget {
  const WorkflowRunDetail({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Page2(
      title: 'Run',
      body: Load<Map>(
        fetch: (api) async => await api.get('/workflow-runs/$id') as Map,
        builder: (context, r, reload) {
          final status = r['status'] as String;
          final steps = items(r, 'steps');
          final approvals = items(r, 'approvals');
          final actions = items(r, 'actions');
          final jobs = items(r, 'jobs');
          final perms = (r['permissions'] as Map?) ?? const {};
          final attention = r['attention'] as Map?;
          final wf = r['workflow'] as Map?;

          Future<void> cancelRun() async {
            final ok = await confirm(context, title: 'Cancel this run?', body: 'It stops at the next step. Steps already done stay done, and any pending approval expires.', action: 'Cancel run', destructive: true);
            if (!ok || !context.mounted) return;
            await act(context, ref, (api) => api.post('/workflow-runs/$id/cancel'), ok: 'Run cancelled');
            await reload();
          }

          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
              if (wf != null) Text(wf['name'] as String? ?? '', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 8),
              Row(children: [
                StatusPill(status),
                const SizedBox(width: 10),
                if (r['dry_run'] == true) Text('Dry run, nothing changed', style: qs(13, c: q.text2)),
                const Spacer(),
                Text('started ${ago(r['started_at'] as String?)}', style: qs(12, c: q.text3)),
              ]),
              const SizedBox(height: 8),
              Text(runStateLine(status), style: qs(14, c: q.text2)),
              if (r['error'] != null && status != 'needs_attention') Padding(padding: const EdgeInsets.only(top: 8), child: Text(r['error'] as String, style: qs(14, c: q.bad))),
              if (attention != null) ...[const SizedBox(height: 14), _AttentionPanel(runId: id, attention: attention, error: r['error'] as String?, canResolve: perms['canResolve'] == true, reload: reload)],
              if (approvals.isNotEmpty) ...[
                const SectionLabel('Approvals'),
                for (final a in approvals)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: QCard(
                      accent: a['status'] == 'pending' ? q.halo.withValues(alpha: .45) : null,
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [
                          Icon(Icons.verified_user_outlined, size: 18, color: a['status'] == 'pending' ? q.halo : q.text2),
                          const SizedBox(width: 10),
                          Expanded(child: Text(a['title'] as String? ?? 'Approval', style: qs(14, w: FontWeight.w600, c: q.text))),
                          StatusPill(a['status'] as String),
                        ]),
                        const SizedBox(height: 4),
                        Text(
                          a['status'] == 'pending'
                              ? 'Asked ${ago(a['created_at'] as String?)} · expires ${dateLabel(a['expires_at'] as String?)}'
                              : a['decided_at'] != null
                                  ? 'Decided ${ago(a['decided_at'] as String?)}'
                                  : 'Asked ${ago(a['created_at'] as String?)}',
                          style: qs(12, c: q.text3),
                        ),
                        if (a['status'] == 'pending') ...[
                          const SizedBox(height: 10),
                          QButton('Review', kind: QBtn.halo, icon: Icons.open_in_new, onPressed: () async {
                            await push(context, ApprovalDetail(id: a['id'] as String));
                            await reload();
                          }),
                        ],
                      ]),
                    ),
                  ),
              ],
              if (actions.isNotEmpty) ...[
                const SectionLabel('Actions outside Qline'),
                for (final a in actions)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 2), child: Icon(a['status'] == 'unknown' || a['status'] == 'executing' ? Icons.help_outline : Icons.outbound_outlined, size: 18, color: a['status'] == 'unknown' ? q.warn : q.text2)),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('Step ${((a['step_index'] as num?) ?? 0) + 1} · ${toolLabel(a['tool'] as String)}', style: qs(14, c: q.text)),
                          if (a['result_summary'] != null) Text(a['result_summary'] as String, style: qs(12, c: q.text3)),
                        ]),
                      ),
                      const SizedBox(width: 8),
                      StatusPill(a['status'] as String),
                    ]),
                  ),
              ],
              const SectionLabel('Steps'),
              if (steps.isEmpty) Text('No steps recorded yet.', style: qs(14, c: q.text3)),
              for (final s in steps)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: QCard(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    child: Row(children: [
                      Icon(stepIcon(s['kind'] as String?), size: 18, color: q.text2),
                      const SizedBox(width: 10),
                      Expanded(child: Text('${(s['step_index'] as num) + 1}. ${s['summary'] ?? s['kind']}', style: qs(14, c: q.text))),
                      const SizedBox(width: 8),
                      StatusPill(s['status'] as String),
                    ]),
                  ),
                ),
              if (jobs.isNotEmpty)
                ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: Text('Background jobs (${jobs.length})', style: qs(13, c: q.text2)),
                  children: [for (final j in jobs) _JobLine(job: j)],
                ),
              if (perms['canCancel'] == true) ...[
                const SizedBox(height: 16),
                QButton('Cancel run', kind: QBtn.destructive, icon: Icons.stop_circle_outlined, expand: true, onPressed: cancelRun),
              ],
            ]),
          );
        },
      ),
    );
  }
}

/// What a stopped run needs. Unknown outcomes are never retried blindly: a person says whether it happened.
class _AttentionPanel extends ConsumerStatefulWidget {
  const _AttentionPanel({required this.runId, required this.attention, required this.error, required this.canResolve, required this.reload});
  final String runId;
  final Map attention;
  final String? error;
  final bool canResolve;
  final Future<void> Function() reload;
  @override
  ConsumerState<_AttentionPanel> createState() => _AttentionPanelState();
}

class _AttentionPanelState extends ConsumerState<_AttentionPanel> {
  String? _busy;

  Future<void> _resolve(String outcome, String ok) async {
    setState(() => _busy = outcome);
    await act(context, ref, (api) => api.post('/workflow-runs/${widget.runId}/resolve', {'outcome': outcome}), ok: ok);
    if (mounted) setState(() => _busy = null);
    await widget.reload();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final unknown = widget.attention['kind'] == 'unknown_outcome';
    final step = ((widget.attention['step'] as num?) ?? 0) + 1;
    final what = unknown ? toolLabel(widget.attention['tool'] as String? ?? 'action') : null;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: q.warn.withValues(alpha: .08), borderRadius: BorderRadius.circular(14), border: Border.all(color: q.warn.withValues(alpha: .45))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(unknown ? Icons.help_outline : Icons.report_outlined, size: 18, color: q.warn),
          const SizedBox(width: 8),
          Expanded(child: Text(unknown ? 'Check step $step before it continues' : 'Stopped at step $step', style: qs(15, w: FontWeight.w600, c: q.text))),
        ]),
        const SizedBox(height: 6),
        Text(
          unknown
              ? 'The $what was interrupted, so it may or may not have gone out. Qline will not resend it on its own. Check whether it went out, then tell Qline.'
              : 'The worker gave up after several tries${widget.error != null ? ': ${widget.error}' : '.'} Retrying is safe: it continues from this step and re-checks approvals.',
          style: qs(13, c: q.text2, h: 1.45),
        ),
        const SizedBox(height: 12),
        if (!widget.canResolve)
          Text('An owner, admin or manager can resolve this.', style: qs(12, c: q.text3))
        else if (unknown)
          Wrap(spacing: 8, runSpacing: 8, children: [
            QButton('It went out', icon: Icons.check, busy: _busy == 'happened', onPressed: _busy == null ? () => _resolve('happened', 'Recorded. The run continues.') : null),
            QButton('It did not, send again', icon: Icons.replay, busy: _busy == 'not_happened', onPressed: _busy == null
                ? () async {
                    final ok = await confirm(context, title: 'Send it again?', body: 'Only do this if you checked and the $what did not go out. Otherwise it will be sent twice.', action: 'Send again');
                    if (ok) await _resolve('not_happened', 'Sending again');
                  }
                : null),
          ])
        else
          QButton('Retry from step $step', icon: Icons.replay, busy: _busy == 'retry', onPressed: _busy == null ? () => _resolve('retry', 'Retrying') : null),
      ]),
    );
  }
}

class _JobLine extends StatelessWidget {
  const _JobLine({required this.job});
  final Map<String, dynamic> job;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(jobKindLabel(job['kind'] as String), style: qs(13, c: q.text)),
            Text('${job['attempts']}/${job['max_attempts']} attempts · ${ago(job['created_at'] as String?)}', style: qs(11, c: q.text3, family: mono)),
            if (job['last_error'] != null) Text(job['last_error'] as String, maxLines: 3, overflow: TextOverflow.ellipsis, style: qs(12, c: q.bad)),
          ]),
        ),
        StatusPill(job['status'] as String),
      ]),
    );
  }
}

/// Background jobs for owners, admins and managers: failed/dead with safe-retry labels, and active jobs to cancel.
class JobsScreen extends StatefulWidget {
  const JobsScreen({super.key});
  @override
  State<JobsScreen> createState() => _JobsScreenState();
}

class _JobsScreenState extends State<JobsScreen> {
  String _status = 'problem';
  @override
  Widget build(BuildContext context) {
    return Page2(
      title: 'Background jobs',
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: SegmentedButton<String>(
            showSelectedIcon: false,
            segments: const [ButtonSegment(value: 'problem', label: Text('Failed')), ButtonSegment(value: 'active', label: Text('Queued & running'))],
            selected: {_status},
            onSelectionChanged: (s) => setState(() => _status = s.first),
          ),
        ),
        Expanded(
          child: Load<List<Map<String, dynamic>>>(
            key: ValueKey(_status),
            fetch: (api) async => items(await api.get('/jobs', {'status': _status})),
            builder: (context, list, reload) => RefreshIndicator(
              onRefresh: reload,
              child: list.isEmpty
                  ? ListView(children: [
                      EmptyState(
                        icon: _status == 'problem' ? Icons.check_circle_outline : Icons.hourglass_empty,
                        title: _status == 'problem' ? 'No failed jobs' : 'Nothing queued',
                        body: _status == 'problem' ? 'Jobs that run out of retries show up here.' : 'The worker picks up new jobs within seconds.',
                      ),
                    ])
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
                      itemCount: list.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (_, i) => JobCard(job: list[i], reload: reload),
                    ),
            ),
          ),
        ),
      ]),
    );
  }
}

class JobCard extends ConsumerStatefulWidget {
  const JobCard({super.key, required this.job, required this.reload});
  final Map<String, dynamic> job;
  final Future<void> Function() reload;
  @override
  ConsumerState<JobCard> createState() => _JobCardState();
}

class _JobCardState extends ConsumerState<JobCard> {
  bool _busy = false;

  Future<void> _do(String path, String ok) async {
    setState(() => _busy = true);
    await act(context, ref, (api) => api.post('/jobs/${widget.job['id']}/$path'), ok: ok);
    if (mounted) setState(() => _busy = false);
    await widget.reload();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final j = widget.job;
    final status = j['status'] as String;
    final problem = status == 'failed' || status == 'dead';
    final safe = j['retry_safe'] == true;
    final runId = j['run_id'] as String?;
    return QCard(
      accent: problem && !safe ? q.warn.withValues(alpha: .5) : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(jobKindLabel(j['kind'] as String), style: qs(15, w: FontWeight.w600, c: q.text))),
          StatusPill(status),
        ]),
        const SizedBox(height: 4),
        Text('${j['attempts']}/${j['max_attempts']} attempts · ${ago(j['updated_at'] as String? ?? j['created_at'] as String?)}', style: qs(12, c: q.text3, family: mono)),
        if (j['last_error'] != null) ...[const SizedBox(height: 6), Text(j['last_error'] as String, maxLines: 3, overflow: TextOverflow.ellipsis, style: qs(13, c: q.bad))],
        if (problem && j['retry_note'] != null) ...[
          const SizedBox(height: 8),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(safe ? Icons.shield_outlined : Icons.help_outline, size: 16, color: safe ? q.ok : q.warn),
            const SizedBox(width: 6),
            Expanded(child: Text(j['retry_note'] as String, style: qs(12, c: q.text2))),
          ]),
        ],
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (problem && safe) QButton('Retry', icon: Icons.replay, busy: _busy, onPressed: () => _do('retry', 'Queued again')),
          if (!problem) QButton('Cancel', kind: QBtn.destructive, icon: Icons.stop_circle_outlined, busy: _busy, onPressed: () => _do('cancel', 'Cancel requested')),
          if (runId != null) QButton('Open run', kind: QBtn.ghost, icon: Icons.chevron_right, onPressed: () => push(context, WorkflowRunDetail(id: runId))),
        ]),
      ]),
    );
  }
}
