import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'business.dart';
import 'work.dart';

class LibraryScreen extends ConsumerStatefulWidget {
  const LibraryScreen({super.key});
  @override
  ConsumerState<LibraryScreen> createState() => _LibraryState();
}

class _LibraryState extends ConsumerState<LibraryScreen> {
  String _view = 'documents';
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Scaffold(
      floatingActionButton: canWrite
          ? FloatingActionButton.extended(
              backgroundColor: context.q.surface2,
              foregroundColor: context.q.text,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: context.q.lineStrong)),
              onPressed: () => _view == 'documents' ? push(context, const NoteEditor()) : _addMemory(context),
              icon: const Icon(Icons.add),
              label: Text(_view == 'documents' ? 'New note' : 'Remember something'),
            )
          : null,
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: SegmentedButton<String>(
            segments: const [ButtonSegment(value: 'documents', label: Text('Documents')), ButtonSegment(value: 'memory', label: Text('Memory'))],
            selected: {_view},
            onSelectionChanged: (s) => setState(() => _view = s.first),
          ),
        ),
        if (_view == 'documents')
          Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search documents', isDense: true), onSubmitted: (v) => setState(() => _q = v.trim()))),
        Expanded(child: _view == 'documents' ? _Docs(key: ValueKey(_q), q: _q) : const _Memory()),
      ]),
    );
  }

  Future<void> _addMemory(BuildContext context) async {
    final v = await promptText(context, title: 'Remember', label: 'A fact, preference or rule for your agents', action: 'Save', maxLines: 4);
    if (v != null && v.isNotEmpty && context.mounted) await act(context, ref, (api) => api.post('/memory', {'content': v, 'kind': 'fact'}), ok: 'Saved to memory');
  }
}

class _Docs extends StatelessWidget {
  const _Docs({super.key, required this.q});
  final String q;
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    return Load<List<Map<String, dynamic>>>(
      fetch: (api) async => items(await api.get('/documents', {'q': q, 'limit': 100})),
      builder: (context, list, reload) => list.isEmpty
          ? ListView(children: const [EmptyState(icon: Icons.description_outlined, title: 'Your library is empty', body: 'Write a note, import a PDF or DOCX, or let an agent save drafts here.')])
          : RefreshIndicator(
              onRefresh: reload,
              child: ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 96),
                itemCount: list.length,
                separatorBuilder: (_, _) => const SizedBox(height: 6),
                itemBuilder: (_, i) {
                  final d = list[i];
                  final icon = switch (d['kind']) { 'draft_email' => Icons.drafts_outlined, 'note' => Icons.sticky_note_2_outlined, _ => Icons.description_outlined };
                  return QCard(
                    onTap: () => push(context, DocumentView(id: d['id'] as String)),
                    padding: const EdgeInsets.all(14),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Icon(icon, color: c.text2),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(d['title'] as String, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: c.text)),
                          if ((d['excerpt'] as String?)?.isNotEmpty == true) Text(d['excerpt'] as String, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: c.text3)),
                          const SizedBox(height: 4),
                          SourceTag(d['source_kind'] as String?, asOf: d['updated_at'] as String? ?? d['created_at'] as String?),
                        ]),
                      ),
                    ]),
                  );
                },
              ),
            ),
    );
  }
}

class DocumentView extends ConsumerWidget {
  const DocumentView({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Load<Map>(
      fetch: (api) async => await api.get('/documents/$id') as Map,
      builder: (context, d, _) => Page2(
        title: cap(d['kind'] as String? ?? 'document'),
        actions: [
          if (canWrite)
            IconButton(
              tooltip: 'Delete',
              icon: const Icon(Icons.delete_outline),
              onPressed: () async {
                if (await confirm(context, title: 'Delete "${d['title']}"?', body: 'It will be removed from your library.', action: 'Delete', destructive: true)) {
                  if (!context.mounted) return;
                  final r = await act(context, ref, (api) => api.delete('/documents/$id'), ok: 'Deleted');
                  if (r != null && context.mounted) Navigator.pop(context);
                }
              },
            ),
        ],
        body: ListView(padding: const EdgeInsets.all(16), children: [
          Text(d['title'] as String, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),
          SourceTag(d['source_kind'] as String?, asOf: d['created_at'] as String?),
          const SizedBox(height: 16),
          SelectableText(d['body'] as String? ?? '', style: qs(15, c: q.text, h: 1.6)),
        ]),
      ),
    );
  }
}

class NoteEditor extends ConsumerStatefulWidget {
  const NoteEditor({super.key});
  @override
  ConsumerState<NoteEditor> createState() => _NoteEditorState();
}

class _NoteEditorState extends ConsumerState<NoteEditor> {
  final _title = TextEditingController(), _body = TextEditingController();
  bool _busy = false;
  @override
  Widget build(BuildContext context) => Page2(
        title: 'New note',
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: QButton('Save', busy: _busy, onPressed: () async {
              if (_title.text.trim().isEmpty) return toast(context, 'Give the note a title');
              setState(() => _busy = true);
              final r = await act(context, ref, (api) => api.post('/documents', {'title': _title.text.trim(), 'body': _body.text, 'kind': 'note'}), ok: 'Saved');
              if (mounted) setState(() => _busy = false);
              if (r != null && context.mounted) Navigator.pop(context);
            }),
          ),
        ],
        body: ListView(padding: const EdgeInsets.all(16), children: [
          TextField(controller: _title, autofocus: true, textCapitalization: TextCapitalization.sentences, style: qs(20, w: FontWeight.w600, c: context.q.text), decoration: const InputDecoration(hintText: 'Title')),
          const SizedBox(height: 12),
          TextField(controller: _body, minLines: 12, maxLines: null, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(hintText: 'Write…')),
        ]),
      );
}

class _Memory extends ConsumerWidget {
  const _Memory();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Load<List<Map<String, dynamic>>>(
      fetch: (api) async => items(await api.get('/memory')),
      builder: (context, list, reload) => list.isEmpty
          ? const EmptyState(icon: Icons.psychology_outlined, title: 'No memories yet', body: 'Things your agents should know — facts, preferences, rules. Agents can propose memories; you confirm them.')
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 96),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: 6),
              itemBuilder: (_, i) {
                final m = list[i];
                final proposed = m['status'] == 'proposed';
                return QCard(
                  accent: proposed ? q.halo.withValues(alpha: .4) : null,
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [StatusPill(m['status'] as String), const SizedBox(width: 8), Text(cap(m['kind'] as String? ?? 'fact'), style: qs(12, c: q.text3)), const Spacer(), SourceTag(m['source_kind'] as String?, asOf: m['created_at'] as String?)]),
                    const SizedBox(height: 8),
                    Text(m['content'] as String, style: qs(15, c: m['status'] == 'superseded' ? q.text3 : q.text)),
                    if (m['confidence'] != null && proposed) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Confidence ${((m['confidence'] as num) * 100).round()}%', style: qs(12, c: q.text3))),
                    if (canWrite && m['status'] != 'superseded')
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Wrap(spacing: 8, runSpacing: 8, children: [
                          if (proposed) QButton('Confirm', kind: QBtn.halo, onPressed: () => act(context, ref, (api) => api.post('/memory/${m['id']}/confirm'), ok: 'Confirmed')),
                          QButton('Update', kind: QBtn.ghost, onPressed: () async {
                            final v = await promptText(context, title: 'Update memory', label: 'New version', initial: m['content'] as String, maxLines: 4);
                            if (v != null && v.isNotEmpty && context.mounted) await act(context, ref, (api) => api.post('/memory/${m['id']}/supersede', {'content': v}), ok: 'Updated — the old version is kept');
                          }),
                          QButton('Forget', kind: QBtn.ghost, onPressed: () async {
                            if (await confirm(context, title: 'Forget this?', body: 'Agents will stop using it.', action: 'Forget', destructive: true)) {
                              if (context.mounted) await act(context, ref, (api) => api.delete('/memory/${m['id']}'), ok: 'Forgotten');
                            }
                          }),
                        ]),
                      ),
                  ]),
                );
              },
            ),
    );
  }
}

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});
  @override
  State<SearchScreen> createState() => _SearchState();
}

class _SearchState extends State<SearchScreen> {
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Scaffold(
      appBar: AppBar(title: TextField(autofocus: true, textInputAction: TextInputAction.search, decoration: const InputDecoration(hintText: 'Search tasks, contacts, library, memory', isDense: true), onSubmitted: (v) => setState(() => _q = v.trim()))),
      body: _q.isEmpty
          ? const EmptyState(icon: Icons.search, title: 'Search everything', body: 'Results come from your workspace only.')
          : Load<Map>(
              key: ValueKey(_q),
              fetch: (api) async => await api.get('/search', {'q': _q}) as Map,
              builder: (context, r, _) {
                final tasks = items(r, 'tasks'), contacts = items(r, 'contacts'), docs = items(r, 'documents'), mem = items(r, 'memory');
                if (tasks.isEmpty && contacts.isEmpty && docs.isEmpty && mem.isEmpty) return EmptyState(icon: Icons.search_off, title: 'Nothing found for "$_q"');
                return ListView(padding: const EdgeInsets.all(16), children: [
                  if (tasks.isNotEmpty) ...[const SectionLabel('Tasks'), for (final t in tasks) QCard(padding: EdgeInsets.zero, child: TaskRow(task: t))],
                  if (contacts.isNotEmpty) ...[
                    const SectionLabel('Contacts'),
                    for (final c in contacts) ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.person_outline), title: Text(c['name'] as String), subtitle: Text(c['email'] as String? ?? ''), onTap: () => push(context, const ContactsScreen())),
                  ],
                  if (docs.isNotEmpty) ...[
                    const SectionLabel('Library'),
                    for (final d in docs) ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.description_outlined), title: Text(d['title'] as String), onTap: () => push(context, DocumentView(id: d['id'] as String))),
                  ],
                  if (mem.isNotEmpty) ...[const SectionLabel('Memory'), for (final m in mem) Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(m['content'] as String, style: qs(14, c: q.text)))],
                ]);
              },
            ),
    );
  }
}
