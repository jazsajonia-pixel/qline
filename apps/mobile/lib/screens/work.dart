import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class WorkScreen extends ConsumerStatefulWidget {
  const WorkScreen({super.key});
  @override
  ConsumerState<WorkScreen> createState() => _WorkState();
}

class _WorkState extends ConsumerState<WorkScreen> {
  String _view = 'open';
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Scaffold(
      floatingActionButton: canWrite && _view != 'projects'
          ? FloatingActionButton.extended(
              // Tabs live in one IndexedStack: shared default hero tags clash when a screen is pushed.
              heroTag: null,
              backgroundColor: context.q.surface2,
              foregroundColor: context.q.text,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: context.q.lineStrong)),
              onPressed: () => showTaskEditor(context, ref),
              icon: const Icon(Icons.add),
              label: const Text('New task'),
            )
          : null,
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: SegmentedButton<String>(
            showSelectedIcon: false, // UX audit 2026-11-21: "Projects" broke onto two lines at large text; labels now shrink to fit.
            segments: [for (final (v, l) in const [('open', 'Open'), ('done', 'Done'), ('projects', 'Projects')]) ButtonSegment(value: v, label: FittedBox(fit: BoxFit.scaleDown, child: Text(l, maxLines: 1)))],
            selected: {_view},
            onSelectionChanged: (s) => setState(() => _view = s.first),
          ),
        ),
        if (_view != 'projects')
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Filter tasks', isDense: true), onSubmitted: (v) => setState(() => _q = v.trim())),
          ),
        Expanded(child: _view == 'projects' ? const _Projects() : _TaskList(key: ValueKey('$_view|$_q'), status: _view, q: _q)),
      ]),
    );
  }
}

class _TaskList extends StatelessWidget {
  const _TaskList({super.key, required this.status, required this.q});
  final String status;
  final String q;
  @override
  Widget build(BuildContext context) => Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/tasks', {'status': status, 'q': q, 'limit': 100})),
        builder: (context, list, reload) => list.isEmpty
            ? ListView(children: [EmptyState(icon: Icons.check_circle_outline, title: status == 'open' ? 'You\'re clear' : 'Nothing finished yet', body: status == 'open' ? 'Add a task, import a spreadsheet, or ask the AI to plan your week.' : null)])
            : RefreshIndicator(
                onRefresh: reload,
                child: ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 96),
                  itemCount: list.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 6),
                  itemBuilder: (_, i) => QCard(padding: EdgeInsets.zero, child: TaskRow(task: list[i])),
                ),
              ),
      );
}

class TaskRow extends ConsumerWidget {
  const TaskRow({super.key, required this.task});
  final Map task;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final done = task['status'] == 'done';
    final due = task['due_at'] as String?;
    final overdue = !done && due != null && DateTime.tryParse(due)?.isBefore(DateTime.now()) == true;
    final pri = task['priority'] as String? ?? 'normal';
    return InkWell(
      onTap: () => push(context, TaskDetail(id: task['id'] as String)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(children: [
          IconButton(
            tooltip: done ? 'Mark as open' : 'Mark as done',
            onPressed: () => act(context, ref, (api) => api.patch('/tasks/${task['id']}', {'status': done ? 'todo' : 'done'})),
            icon: Icon(done ? Icons.check_circle : Icons.radio_button_unchecked, color: done ? q.ok : q.text3),
          ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(task['title'] as String, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w500, c: done ? q.text3 : q.text).copyWith(decoration: done ? TextDecoration.lineThrough : null)),
              if (due != null || pri == 'high' || pri == 'urgent')
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  // UX audit 2026-11-21: Wrap, so date and priority move to a second line at large text.
                  child: Wrap(spacing: 10, runSpacing: 2, children: [
                    if (due != null)
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(overdue ? Icons.warning_amber_rounded : Icons.event_outlined, size: 13, color: overdue ? q.bad : q.text3),
                        const SizedBox(width: 3),
                        Text(overdue ? 'Overdue · ${dateLabel(due)}' : dateLabel(due), style: qs(12, c: overdue ? q.bad : q.text3)),
                      ]),
                    if (pri == 'high' || pri == 'urgent') Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.flag_outlined, size: 13, color: q.warn), const SizedBox(width: 3), Text(cap(pri), style: qs(12, c: q.warn))]),
                  ]),
                ),
            ]),
          ),
          if (task['source_kind'] != null && task['source_kind'] != 'user')
            Padding(padding: const EdgeInsets.only(right: 12), child: SourceTag(task['source_kind'] as String?)),
        ]),
      ),
    );
  }
}

Future<void> showTaskEditor(BuildContext context, WidgetRef ref, {Map? task, String? projectId}) async {
  final title = TextEditingController(text: task?['title'] as String?);
  final desc = TextEditingController(text: task?['description'] as String?);
  String priority = task?['priority'] as String? ?? 'normal';
  DateTime? due = DateTime.tryParse(task?['due_at'] as String? ?? '')?.toLocal();
  String? error;
  await showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
      final q = ctx.q;
      return Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(ctx).viewInsets.bottom + 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(task == null ? 'New task' : 'Edit task', style: qs(18, w: FontWeight.w600, c: q.text)),
          const SizedBox(height: 16),
          TextField(controller: title, autofocus: task == null, textCapitalization: TextCapitalization.sentences, decoration: InputDecoration(labelText: 'Title', errorText: error)),
          const SizedBox(height: 12),
          TextField(controller: desc, minLines: 2, maxLines: 5, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(labelText: 'Details (optional)')),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final p in ['low', 'normal', 'high', 'urgent']) ChoiceChip(label: Text(cap(p)), selected: priority == p, onSelected: (_) => set(() => priority = p)),
          ]),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48), side: BorderSide(color: q.lineStrong), foregroundColor: q.text),
            onPressed: () async {
              final d = await showDatePicker(context: ctx, firstDate: DateTime.now().subtract(const Duration(days: 365)), lastDate: DateTime.now().add(const Duration(days: 365 * 3)), initialDate: due ?? DateTime.now());
              if (d != null) set(() => due = DateTime(d.year, d.month, d.day, 17));
            },
            icon: const Icon(Icons.event_outlined),
            label: Text(due == null ? 'Add due date' : 'Due ${DateFormat('EEE, MMM d').format(due!)}'),
          ),
          if (due != null) TextButton(onPressed: () => set(() => due = null), child: const Text('Clear due date')),
          const SizedBox(height: 16),
          QButton(task == null ? 'Add task' : 'Save', kind: QBtn.secondary, expand: true, onPressed: () async {
            if (title.text.trim().isEmpty) return set(() => error = 'Give the task a title');
            final body = {
              'title': title.text.trim(),
              'description': desc.text.trim().isEmpty ? null : desc.text.trim(),
              'priority': priority,
              'dueAt': due?.toUtc().toIso8601String(),
              'projectId': ?projectId,
            };
            final r = await act(ctx, ref, (api) => task == null ? api.post('/tasks', body) : api.patch('/tasks/${task['id']}', body));
            if (r != null && ctx.mounted) Navigator.pop(ctx);
          }),
        ]),
      );
    }),
  );
}

class TaskDetail extends ConsumerStatefulWidget {
  const TaskDetail({super.key, required this.id});
  final String id;
  @override
  ConsumerState<TaskDetail> createState() => _TaskDetailState();
}

class _TaskDetailState extends ConsumerState<TaskDetail> {
  final _comment = TextEditingController();
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Load<Map>(
      fetch: (api) async => await api.get('/tasks/${widget.id}') as Map,
      builder: (context, t, reload) {
        final comments = items(t, 'comments');
        final done = t['status'] == 'done';
        return Page2(
          title: 'Task',
          actions: [
            if (canWrite) IconButton(tooltip: 'Edit', icon: const Icon(Icons.edit_outlined), onPressed: () => showTaskEditor(context, ref, task: t)),
            if (canWrite)
              IconButton(
                tooltip: 'Delete',
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  if (await confirm(context, title: 'Delete task?', body: 'It will be removed from your lists. This is recorded in the audit log.', action: 'Delete', destructive: true)) {
                    if (!context.mounted) return;
                    final r = await act(context, ref, (api) => api.delete('/tasks/${widget.id}'), ok: 'Task deleted');
                    if (r != null && context.mounted) Navigator.pop(context);
                  }
                },
              ),
          ],
          body: ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [StatusPill(t['status'] as String), const SizedBox(width: 10), SourceTag(t['source_kind'] as String?, asOf: t['created_at'] as String?)]),
            const SizedBox(height: 12),
            Text(t['title'] as String, style: Theme.of(context).textTheme.headlineSmall),
            if ((t['description'] as String?)?.isNotEmpty == true) ...[const SizedBox(height: 10), Text(t['description'] as String, style: qs(15, c: q.text2))],
            const SizedBox(height: 12),
            KV('Priority', cap(t['priority'] as String? ?? 'normal')),
            KV('Due', t['due_at'] == null ? 'No due date' : dateLabel(t['due_at'] as String?)),
            if (t['completed_at'] != null) KV('Completed', dateLabel(t['completed_at'] as String?)),
            const SizedBox(height: 12),
            if (canWrite) QButton(done ? 'Reopen task' : 'Mark as done', icon: done ? Icons.undo : Icons.check, expand: true, onPressed: () => act(context, ref, (api) => api.patch('/tasks/${widget.id}', {'status': done ? 'todo' : 'done'}))),
            SectionLabel('Comments (${comments.length})'),
            for (final c in comments)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: QCard(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${c['author_name'] ?? cap(c['author_kind'] as String? ?? 'user')} · ${ago(c['created_at'] as String?)}', style: qs(12, c: q.text3)),
                    const SizedBox(height: 4),
                    Text(c['body'] as String, style: qs(14, c: q.text)),
                  ]),
                ),
              ),
            if (canWrite)
              TextField(
                controller: _comment,
                minLines: 1,
                maxLines: 4,
                decoration: InputDecoration(
                  hintText: 'Add a comment',
                  suffixIcon: IconButton(
                    tooltip: 'Post comment',
                    icon: const Icon(Icons.send),
                    onPressed: () async {
                      final v = _comment.text.trim();
                      if (v.isEmpty) return;
                      final r = await act(context, ref, (api) => api.post('/tasks/${widget.id}/comments', {'body': v}));
                      if (r != null) _comment.clear();
                    },
                  ),
                ),
              ),
          ]),
        );
      },
    );
  }
}

class _Projects extends ConsumerWidget {
  const _Projects();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Load<List<Map<String, dynamic>>>(
      fetch: (api) async => items(await api.get('/projects')),
      builder: (context, list, reload) => ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
        if (canWrite)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: QButton('New project', icon: Icons.add, expand: true, onPressed: () async {
              final name = await promptText(context, title: 'New project', label: 'Project name', action: 'Create');
              if (name != null && name.isNotEmpty && context.mounted) await act(context, ref, (api) => api.post('/projects', {'name': name}));
            }),
          ),
        if (list.isEmpty) const EmptyState(icon: Icons.folder_open_outlined, title: 'No projects yet', body: 'Group related tasks into a project to track progress.'),
        for (final p in list)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: QCard(
              onTap: () => push(context, _ProjectTasks(project: p)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [Expanded(child: Text(p['name'] as String, style: qs(15, w: FontWeight.w600, c: q.text))), StatusPill(p['status'] as String? ?? 'active')]),
                const SizedBox(height: 10),
                Builder(builder: (_) {
                  final total = (p['task_count'] as num? ?? 0).toInt(), done = (p['done_count'] as num? ?? 0).toInt();
                  return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: total == 0 ? 0 : done / total, minHeight: 6)),
                    const SizedBox(height: 6),
                    Text('$done of $total tasks done', style: qs(12, c: q.text3)),
                  ]);
                }),
              ]),
            ),
          ),
      ]),
    );
  }
}

class _ProjectTasks extends ConsumerWidget {
  const _ProjectTasks({required this.project});
  final Map project;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Page2(
        title: project['name'] as String,
        fab: ref.watch(sessionProvider.select((s) => s.canWrite))
            ? FloatingActionButton(tooltip: 'Add task', onPressed: () => showTaskEditor(context, ref, projectId: project['id'] as String), child: const Icon(Icons.add))
            : null,
        body: Load<List<Map<String, dynamic>>>(
          fetch: (api) async => items(await api.get('/tasks', {'projectId': project['id'], 'limit': 100})),
          builder: (context, list, reload) => list.isEmpty
              ? const EmptyState(icon: Icons.check_circle_outline, title: 'No tasks in this project')
              : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: list.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 6),
                  itemBuilder: (_, i) => QCard(padding: EdgeInsets.zero, child: TaskRow(task: list[i])),
                ),
        ),
      );
}
