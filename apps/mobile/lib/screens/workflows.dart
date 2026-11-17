import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'operations.dart';

/// Ready-made workflow recipes. Every action that changes data is preceded by an
/// approval step, which the server enforces at publish time.
final recipes = <Map<String, dynamic>>[
  {
    'name': 'Follow up new contacts',
    'description': 'When a contact is added, ask before creating a follow-up task due in 2 days.',
    'definition': {
      'trigger': {'type': 'event', 'event': 'contact.created'},
      'steps': [
        {'type': 'approval', 'title': 'Create a follow-up task for {{trigger.name}}?'},
        {'type': 'action', 'tool': 'tasks.create', 'args': {'title': 'Follow up with {{trigger.name}}', 'dueInDays': 2, 'priority': 'normal'}},
        {'type': 'notify', 'title': 'Follow-up scheduled for {{trigger.name}}'},
      ],
    },
  },
  {
    'name': 'Daily planning reminder',
    'description': 'Every morning (08:00 Manila / 00:00 UTC), remind you to review today\'s work.',
    'definition': {
      'trigger': {'type': 'schedule', 'every': 'day', 'hourUtc': 0},
      'steps': [
        {'type': 'notify', 'title': 'Plan your day', 'body': 'Open Work to review what\'s due today.'},
      ],
    },
  },
  {
    'name': 'Review imported data',
    'description': 'After an import finishes, ask before creating a review task.',
    'definition': {
      'trigger': {'type': 'event', 'event': 'import.completed'},
      'steps': [
        {'type': 'approval', 'title': 'Create a task to review the import?'},
        {'type': 'action', 'tool': 'tasks.create', 'args': {'title': 'Review imported records', 'dueInDays': 1}},
      ],
    },
  },
  {
    'name': 'Weekly client check-in (manual)',
    'description': 'Run by hand: ask, then create a check-in task and note.',
    'definition': {
      'trigger': {'type': 'manual'},
      'steps': [
        {'type': 'approval', 'title': 'Create this week\'s client check-in?'},
        {'type': 'action', 'tool': 'tasks.create', 'args': {'title': 'Weekly client check-in', 'dueInDays': 3, 'priority': 'high'}},
        {'type': 'action', 'tool': 'notes.create', 'args': {'title': 'Client check-in notes', 'body': 'Who did we talk to? What did they need?'}},
      ],
    },
  },
];

String triggerLabel(Map? t) => switch (t?['type']) {
      'event' => switch (t!['event']) {
          'lead.created' => 'When a new lead arrives',
          'lead.urgent' => 'When an urgent lead arrives',
          _ => 'When ${(t['event'] as String).replaceAll('.', ' ')}',
        },
      'schedule' => 'Daily at ${t!['hourUtc']}:00 UTC',
      _ => 'Run by hand',
    };

String stepLabel(Map s) => switch (s['type']) {
      'approval' => 'Ask: ${s['title']}',
      'notify' => 'Notify: ${s['title']}',
      'ai' => 'AI writes ${s['saveAs'] ?? 'a draft'}',
      'slack' => 'Slack: ${s['text'] ?? s['title'] ?? 'post a message'}',
      'email' => 'Email ${s['to'] ?? 'the lead'}: ${s['subject'] ?? ''}',
      'calendar' => 'Calendar: ${s['title'] ?? 'add an event'}',
      _ => '${s['tool']} — ${(s['args'] as Map?)?['title'] ?? ''}',
    };

IconData stepIcon(String? type) => switch (type) {
      'approval' => Icons.verified_user_outlined,
      'notify' => Icons.notifications_none,
      'ai' => Icons.auto_awesome_outlined,
      'slack' => Icons.tag,
      'email' => Icons.mail_outline,
      'calendar' => Icons.event_outlined,
      _ => Icons.bolt,
    };

/// One-tap automations built on integrations (server recipes).
class _Automations extends ConsumerWidget {
  const _Automations({required this.canManage});
  final bool canManage;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Load<List<Map<String, dynamic>>>(
      fetch: (api) async => items(await api.get('/workflow-recipes')),
      skeleton: const SizedBox(height: 4),
      builder: (context, list, reload) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel('Ready-made automations'),
        for (final r in list)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: QCard(
              accent: r['installed'] == true ? q.halo.withValues(alpha: .4) : null,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(r['name'] as String, style: qs(15, w: FontWeight.w600, c: q.text))),
                  if (r['installed'] == true) const StatusPill('enabled'),
                ]),
                const SizedBox(height: 4),
                Text(r['description'] as String, style: qs(13, c: q.text2, h: 1.4)),
                const SizedBox(height: 6),
                Text('Needs: ${((r['needs'] as List?) ?? const []).join(' · ')}', style: qs(12, c: q.text3)),
                if (r['installed'] != true && canManage) ...[
                  const SizedBox(height: 10),
                  QButton('Turn on', icon: Icons.play_arrow, onPressed: () async {
                    final w = await act(context, ref, (api) => api.post('/workflow-recipes/${r['id']}/install'), ok: '${r['name']} is on');
                    if (w != null) await reload();
                  }),
                ],
              ]),
            ),
          ),
      ]),
    );
  }
}

class WorkflowsScreen extends ConsumerWidget {
  const WorkflowsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canManage = ref.watch(sessionProvider.select((s) => s.role != 'viewer' && s.role != 'member'));
    return Page2(
      title: 'Workflows',
      fab: canManage ? FloatingActionButton.extended(onPressed: () => _pickRecipe(context, ref), icon: const Icon(Icons.add), label: const Text('New workflow')) : null,
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/workflows')),
        builder: (context, list, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 96), children: [
            const OpsStrip(),
            _Automations(canManage: canManage),
            SectionLabel('Your workflows${list.isEmpty ? '' : ' (${list.length})'}'),
            if (list.isEmpty)
              EmptyState(
                icon: Icons.account_tree_outlined,
                title: 'No workflows yet',
                body: 'Turn on a ready-made automation above, or start from a recipe. Workflows run on the server on their schedule or trigger, and ask before risky actions.',
                action: canManage ? QButton('Browse recipes', onPressed: () => _pickRecipe(context, ref)) : null,
              )
            else
              for (final (i, w) in list.indexed)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Reveal(
                    index: i,
                    child: QCard(
                      onTap: () => push(context, WorkflowDetail(id: w['id'] as String)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [Expanded(child: Text(w['name'] as String, style: qs(15, w: FontWeight.w600, c: q.text))), StatusPill(w['published_version'] == null ? 'draft' : w['status'] as String)]),
                        const SizedBox(height: 4),
                        Text('${triggerLabel((w['draft'] is Map ? w['draft'] as Map : const {})['trigger'] as Map?)} · ${w['run_count']} runs${w['last_run_at'] != null ? ' · last ${ago(w['last_run_at'] as String?)}' : ''}', style: qs(13, c: q.text3)),
                      ]),
                    ),
                  ),
                ),
          ]),
        ),
      ),
    );
  }

  Future<void> _pickRecipe(BuildContext context, WidgetRef ref) async {
    final r = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
          Text('Start from a recipe', style: qs(18, w: FontWeight.w600, c: ctx.q.text)),
          const SizedBox(height: 4),
          Text('It\'s saved as a draft. Review, then publish and enable it.', style: qs(13, c: ctx.q.text2)),
          const SizedBox(height: 12),
          for (final r in recipes)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: QCard(
                onTap: () => Navigator.pop(ctx, r),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(r['name'] as String, style: qs(15, w: FontWeight.w600, c: ctx.q.text)),
                  const SizedBox(height: 2),
                  Text(r['description'] as String, style: qs(13, c: ctx.q.text3)),
                ]),
              ),
            ),
        ]),
      ),
    );
    if (r == null || !context.mounted) return;
    final w = await act(context, ref, (api) => api.post('/workflows', r), ok: 'Draft created');
    if (w is Map && context.mounted) push(context, WorkflowDetail(id: w['id'] as String));
  }
}

class WorkflowDetail extends ConsumerWidget {
  const WorkflowDetail({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canManage = ref.watch(sessionProvider.select((s) => s.role != 'viewer' && s.role != 'member'));
    return Page2(
      title: 'Workflow',
      body: Load<Map>(
        fetch: (api) async => await api.get('/workflows/$id') as Map,
        builder: (context, w, reload) {
          final def = w['draft'] is Map ? w['draft'] as Map : const {};
          final steps = (def['steps'] as List? ?? const []).cast<Map>();
          final runs = items(w, 'runs');
          final published = w['published_version'] != null;
          final enabled = w['status'] == 'enabled';
          final manual = (def['trigger'] as Map?)?['type'] == 'manual';
          Future<void> run(String path, String ok) async {
            final r = await act(context, ref, (api) => api.post('/workflows/$id/$path', path.contains('run') ? {'data': <String, dynamic>{}} : null), ok: ok);
            await reload();
            if (r is Map && r['steps'] != null && context.mounted) push(context, WorkflowRunDetail(id: r['id'] as String));
          }

          return ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [StatusPill(published ? w['status'] as String : 'draft'), const SizedBox(width: 8), if (published) Text('v${w['published_version']}', style: qs(12, c: q.text3, family: mono))]),
            const SizedBox(height: 10),
            Text(w['name'] as String, style: Theme.of(context).textTheme.headlineSmall),
            if (w['description'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(w['description'] as String, style: qs(14, c: q.text2))),
            const SectionLabel('Steps'),
            QCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [Icon(Icons.play_circle_outline, size: 18, color: q.text2), const SizedBox(width: 10), Text(triggerLabel(def['trigger'] as Map?), style: qs(14, w: FontWeight.w600, c: q.text))]),
                for (final (i, s) in steps.indexed)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Icon(stepIcon(s['type'] as String?), size: 18, color: s['type'] == 'approval' ? q.halo : q.text2),
                      const SizedBox(width: 10),
                      Expanded(child: Text('${i + 1}. ${stepLabel(s)}', style: qs(14, c: q.text))),
                    ]),
                  ),
              ]),
            ),
            const SizedBox(height: 8),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text('Definition (JSON)', style: qs(13, c: q.text2)),
              children: [SelectableText(const JsonEncoder.withIndent('  ').convert(def), style: qs(11, c: q.text2, family: mono))],
            ),
            if (canManage) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                QButton('Dry run', icon: Icons.science_outlined, onPressed: () => run('dry-run', 'Dry run finished — nothing was changed')),
                QButton(published ? 'Publish changes' : 'Publish', icon: Icons.publish, onPressed: () => run('publish', 'Published')),
                if (published) QButton(enabled ? 'Disable' : 'Enable', icon: enabled ? Icons.pause : Icons.play_arrow, onPressed: () => run(enabled ? 'disable' : 'enable', enabled ? 'Disabled' : 'Enabled')),
                if (published && manual) QButton('Run now', icon: Icons.play_arrow, onPressed: () => run('run', 'Started')),
              ]),
            ],
            SectionLabel('Recent runs', trailing: runs.isEmpty ? null : TextButton(onPressed: () => push(context, RunsScreen(initialView: 'all', workflowId: id)), child: Text('All runs', style: qs(13, w: FontWeight.w600, c: q.text2)))),
            if (runs.isEmpty) Text('No runs yet. Try a dry run first.', style: qs(14, c: q.text3)),
            for (final r in runs.take(5))
              Padding(padding: const EdgeInsets.only(bottom: 8), child: RunTile(run: r, showWorkflow: false, onReturn: reload)),
          ]);
        },
      ),
    );
  }
}
