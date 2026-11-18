import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'knowledge_graph.dart';

/// Knowledge OS (v1.6 run 3): categorized entries, private by default, with revisions and links.
/// Privacy is enforced by the API database; this screen only shows what comes back.

const knowledgeKinds = ['fact', 'policy', 'process', 'decision', 'lesson', 'preference', 'context', 'note'];
const knowledgeRelations = {
  'about': 'Is about',
  'related_to': 'Related to',
  'part_of': 'Part of',
  'depends_on': 'Depends on',
  'decided_in': 'Decided in',
  'source_of': 'Source of',
  'owned_by': 'Owned by',
  'supersedes': 'Replaces',
  'contradicts': 'Contradicts',
};

IconData knowledgeTypeIcon(String type) => switch (type) {
      'entry' => Icons.lightbulb_outline,
      'document' => Icons.description_outlined,
      'contact' => Icons.person_outline,
      'company' => Icons.business_outlined,
      'project' => Icons.folder_outlined,
      'task' => Icons.check_box_outlined,
      'category' => Icons.category_outlined,
      _ => Icons.circle_outlined,
    };

/// Library → Knowledge tab body.
class KnowledgeView extends StatefulWidget {
  const KnowledgeView({super.key});
  @override
  State<KnowledgeView> createState() => _KnowledgeViewState();
}

class _KnowledgeViewState extends State<KnowledgeView> {
  String _q = '';
  String? _category;
  bool _proposedOnly = false;
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.q;
    return Load<Map>(
      key: ValueKey('$_q|$_category|$_proposedOnly'),
      fetch: (api) async {
        final cats = await api.get('/knowledge/categories') as Map;
        final entries = await api.get('/knowledge/entries', {if (_q.isNotEmpty) 'q': _q, 'category': ?_category, if (_proposedOnly) 'status': 'proposed', 'limit': 100});
        return {'cats': items(cats), 'entries': items(entries)};
      },
      builder: (context, d, reload) {
        final cats = (d['cats'] as List).cast<Map<String, dynamic>>();
        final list = (d['entries'] as List).cast<Map<String, dynamic>>();
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 96), children: [
            Row(children: [
              Expanded(
                child: TextField(
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search knowledge', isDense: true),
                  controller: _search,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (v) => setState(() => _q = v.trim()),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.outlined(tooltip: 'Knowledge map', icon: const Icon(Icons.hub_outlined), onPressed: () => push(context, const KnowledgeGraphScreen())),
            ]),
            const SizedBox(height: 10),
            SizedBox(
              height: 36,
              child: ListView(scrollDirection: Axis.horizontal, children: [
                Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(label: const Text('All'), selected: _category == null && !_proposedOnly, onSelected: (_) => setState(() {
                          _category = null;
                          _proposedOnly = false;
                        }))),
                Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(label: const Text('To review'), selected: _proposedOnly, onSelected: (v) => setState(() => _proposedOnly = v))),
                for (final k in cats)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(label: Text('${k['name']}${((k['count'] as num?) ?? 0) > 0 ? ' · ${k['count']}' : ''}'), selected: _category == k['id'], onSelected: (v) => setState(() => _category = v ? k['id'] as String : null)),
                  ),
              ]),
            ),
            const SizedBox(height: 10),
            if (list.isEmpty)
              EmptyState(
                icon: Icons.lightbulb_outline,
                title: _q.isEmpty ? 'No knowledge here yet' : 'Nothing found for "$_q"',
                body: 'Write down how the business works: prices, policies, steps, decisions. New entries are private to you until you share them.',
              )
            else
              for (final e in list) Padding(padding: const EdgeInsets.only(bottom: 6), child: KnowledgeCard(entry: e)),
            if (list.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('${list.length} entr${list.length == 1 ? 'y' : 'ies'}', textAlign: TextAlign.center, style: qs(12, c: c.text3))),
          ]),
        );
      },
    );
  }
}

class KnowledgeCard extends StatelessWidget {
  const KnowledgeCard({super.key, required this.entry});
  final Map<String, dynamic> entry;
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    final e = entry;
    final proposed = e['status'] == 'proposed';
    final private = e['visibility'] == 'private';
    return QCard(
      accent: proposed ? c.halo.withValues(alpha: .4) : null,
      padding: const EdgeInsets.all(14),
      onTap: () => push(context, KnowledgeEntryScreen(id: e['id'] as String)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (e['pinned'] == true) Padding(padding: const EdgeInsets.only(right: 4), child: Icon(Icons.push_pin, size: 14, color: c.text2)),
          Expanded(child: Text(e['title'] as String? ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: c.text))),
          const SizedBox(width: 8),
          VisibilityTag(private: private),
        ]),
        if ((e['body'] as String?)?.isNotEmpty == true) Padding(padding: const EdgeInsets.only(top: 4), child: Text(e['body'] as String, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: c.text2))),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
          if (proposed) const StatusPill('proposed'),
          Text('${cap(e['kind'] as String? ?? 'fact')} · ${e['category'] ?? 'Inbox'}', style: qs(12, c: c.text3)),
          SourceTag(e['source_kind'] == 'agent_inferred' ? 'ai_suggested' : e['source_kind'] as String?, asOf: e['updated_at'] as String?),
        ]),
      ]),
    );
  }
}

/// Private / Shared, with an icon so it does not rely on colour.
class VisibilityTag extends StatelessWidget {
  const VisibilityTag({super.key, required this.private});
  final bool private;
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    return Semantics(
      label: private ? 'Private to you' : 'Shared with the workspace',
      excludeSemantics: true,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(private ? Icons.lock_outline : Icons.groups_outlined, size: 14, color: private ? c.text2 : c.info),
        const SizedBox(width: 3),
        Text(private ? 'Private' : 'Shared', style: qs(12, w: FontWeight.w600, c: private ? c.text2 : c.info)),
      ]),
    );
  }
}

class KnowledgeEntryScreen extends ConsumerWidget {
  const KnowledgeEntryScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Load<Map>(
      fetch: (api) async => await api.get('/knowledge/entries/$id') as Map,
      builder: (context, e, reload) {
        final private = e['visibility'] == 'private';
        final mine = e['mine'] == true;
        final proposed = e['status'] == 'proposed';
        final links = items(e, 'links');
        final revs = items(e, 'revisions');
        return Page2(
          title: cap(e['kind'] as String? ?? 'entry'),
          actions: [
            if (canWrite)
              IconButton(
                tooltip: 'Edit',
                icon: const Icon(Icons.edit_outlined),
                onPressed: () => push(context, KnowledgeEditor(entry: e.cast<String, dynamic>())),
              ),
            if (canWrite)
              IconButton(
                tooltip: 'Delete',
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  if (await confirm(context, title: 'Delete "${e['title']}"?', body: 'Agents will stop using it. Links to it are removed from the map.', action: 'Delete', destructive: true)) {
                    if (!context.mounted) return;
                    final r = await act(context, ref, (api) => api.delete('/knowledge/entries/$id'), ok: 'Deleted');
                    if (r != null && context.mounted) Navigator.pop(context);
                  }
                },
              ),
          ],
          body: ListView(padding: const EdgeInsets.all(16), children: [
            Text(e['title'] as String? ?? '', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              VisibilityTag(private: private),
              if (proposed) const StatusPill('proposed'),
              Text(e['category'] as String? ?? 'Inbox', style: qs(12, c: c.text3)),
              SourceTag(e['source_kind'] == 'agent_inferred' ? 'ai_suggested' : e['source_kind'] as String?, asOf: e['updated_at'] as String?),
            ]),
            const SizedBox(height: 16),
            SelectableText(e['body'] as String? ?? '', style: qs(15, c: c.text, h: 1.6)),
            if (canWrite) ...[
              const SizedBox(height: 16),
              Wrap(spacing: 8, runSpacing: 8, children: [
                if (proposed) QButton('Confirm', kind: QBtn.halo, icon: Icons.check, onPressed: () => act(context, ref, (api) => api.post('/knowledge/entries/$id/confirm'), ok: 'Confirmed')),
                if (mine && private)
                  QButton('Share with workspace', icon: Icons.groups_outlined, onPressed: () async {
                    if (await confirm(context, title: 'Share this entry?', body: 'Everyone in this workspace, and their agents, will be able to read it.', action: 'Share')) {
                      if (context.mounted) await act(context, ref, (api) => api.post('/knowledge/entries/$id/share'), ok: 'Shared');
                    }
                  }),
                if (mine && !private) QButton('Make private', kind: QBtn.ghost, icon: Icons.lock_outline, onPressed: () => act(context, ref, (api) => api.post('/knowledge/entries/$id/unshare'), ok: 'Only you can see it now')),
                QButton('Connect to…', kind: QBtn.ghost, icon: Icons.link, onPressed: () => showLinkPicker(context, ref, id)),
                QButton('Show on map', kind: QBtn.ghost, icon: Icons.hub_outlined, onPressed: () => push(context, KnowledgeGraphScreen(focus: 'entry:$id'))),
              ]),
            ],
            const SectionLabel('Connections'),
            if (links.isEmpty) Text('Not connected to anything yet.', style: qs(14, c: c.text3)),
            for (final l in links)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(knowledgeTypeIcon(l['type'] as String), color: c.text2),
                title: Text(l['title'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('${l['direction'] == 'in' ? 'Linked from' : (knowledgeRelations[l['relation']] ?? cap(l['relation'] as String))} · ${cap(l['type'] as String)}${l['aiAdded'] == true ? ' · Added by AI' : ''}', style: qs(12, c: c.text3)),
                trailing: canWrite
                    ? IconButton(tooltip: 'Remove link', icon: const Icon(Icons.link_off), onPressed: () => act(context, ref, (api) => api.delete('/knowledge/links/${l['id']}'), ok: 'Link removed'))
                    : null,
                onTap: l['type'] == 'entry' && l['title'] != 'Not available to you' ? () => push(context, KnowledgeEntryScreen(id: l['targetId'] as String)) : null,
              ),
            const SectionLabel('History'),
            for (final r in revs)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text('Revision ${r['revision']} · ${_change(r['change_kind'] as String?)} · ${ago(r['changed_at'] as String?)}${(r['changed_by'] as String?)?.startsWith('agent:') == true ? ' · by an agent' : ''}', style: qs(13, c: c.text2)),
              ),
          ]),
        );
      },
    );
  }

  static String _change(String? k) => switch (k) { 'create' => 'Created', 'edit' => 'Edited', 'share' => 'Shared', 'unshare' => 'Made private', 'confirm' => 'Confirmed', 'restore' => 'Restored', _ => cap(k ?? '') };
}

/// "Connect to…" picker: search any record, then choose how they relate.
Future<void> showLinkPicker(BuildContext context, WidgetRef ref, String entryId) => showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom), child: _LinkPicker(entryId: entryId)),
    );

class _LinkPicker extends ConsumerStatefulWidget {
  const _LinkPicker({required this.entryId});
  final String entryId;
  @override
  ConsumerState<_LinkPicker> createState() => _LinkPickerState();
}

class _LinkPickerState extends ConsumerState<_LinkPicker> {
  String _q = '';
  String _relation = 'about';
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * .7,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Connect to…', style: qs(18, w: FontWeight.w600, c: c.text)),
          const SizedBox(height: 10),
          TextField(autofocus: true, decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Contact, company, project, task, document or entry', isDense: true), onSubmitted: (v) => setState(() => _q = v.trim())),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            initialValue: _relation,
            decoration: const InputDecoration(labelText: 'How they relate', isDense: true),
            items: [for (final r in knowledgeRelations.entries) DropdownMenuItem(value: r.key, child: Text(r.value))],
            onChanged: (v) => setState(() => _relation = v ?? 'about'),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: _q.isEmpty
                ? Center(child: Text('Type a name and press search.', style: qs(14, c: c.text3)))
                : Load<List<Map<String, dynamic>>>(
                    key: ValueKey(_q),
                    fetch: (api) async => items(await api.get('/knowledge/targets', {'q': _q})),
                    builder: (context, list, _) {
                      final rows = list.where((t) => !(t['type'] == 'entry' && t['id'] == widget.entryId)).toList();
                      if (rows.isEmpty) return Center(child: Text('Nothing found for "$_q".', style: qs(14, c: c.text3)));
                      return ListView(children: [
                        for (final t in rows)
                          ListTile(
                            leading: Icon(knowledgeTypeIcon(t['type'] as String), color: c.text2),
                            title: Text(t['title'] as String? ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
                            subtitle: Text(cap(t['type'] as String)),
                            onTap: () async {
                              final r = await act(context, ref, (api) => api.post('/knowledge/links', {'fromEntry': widget.entryId, 'toType': t['type'], 'toId': t['id'], 'relation': _relation}), ok: 'Connected');
                              if (r != null && context.mounted) Navigator.pop(context);
                            },
                          ),
                      ]);
                    },
                  ),
          ),
        ]),
      ),
    );
  }
}

/// Create or edit an entry. Edits send the revision they started from, so two people
/// editing at once never overwrite each other silently.
class KnowledgeEditor extends ConsumerStatefulWidget {
  const KnowledgeEditor({super.key, this.entry});
  final Map<String, dynamic>? entry;
  @override
  ConsumerState<KnowledgeEditor> createState() => _KnowledgeEditorState();
}

class _KnowledgeEditorState extends ConsumerState<KnowledgeEditor> {
  late final _title = TextEditingController(text: widget.entry?['title'] as String? ?? '');
  late final _body = TextEditingController(text: widget.entry?['body'] as String? ?? '');
  late String _kind = widget.entry?['kind'] as String? ?? 'fact';
  late String? _category = widget.entry?['category_id'] as String?;
  late bool _shared = widget.entry?['visibility'] == 'workspace';
  bool _busy = false;

  bool get _editing => widget.entry != null;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_title.text.trim().isEmpty) return toast(context, 'Give it a title');
    setState(() => _busy = true);
    final payload = {'title': _title.text.trim(), 'body': _body.text.trim(), 'kind': _kind, 'categoryId': ?_category};
    final r = await act(
      context,
      ref,
      (api) => _editing ? api.patch('/knowledge/entries/${widget.entry!['id']}', {...payload, 'ifRevision': widget.entry!['revision']}) : api.post('/knowledge/entries', {...payload, 'visibility': _shared ? 'workspace' : 'private'}),
      ok: 'Saved',
    );
    if (mounted) setState(() => _busy = false);
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.q;
    return Page2(
      title: _editing ? 'Edit entry' : 'New knowledge',
      actions: [Padding(padding: const EdgeInsets.only(right: 8), child: QButton('Save', busy: _busy, onPressed: _save))],
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/knowledge/categories')),
        builder: (context, cats, _) => ListView(padding: const EdgeInsets.all(16), children: [
          TextField(controller: _title, autofocus: !_editing, textCapitalization: TextCapitalization.sentences, style: qs(20, w: FontWeight.w600, c: c.text), decoration: const InputDecoration(hintText: 'Title, e.g. "Delivery days"')),
          const SizedBox(height: 12),
          TextField(controller: _body, minLines: 8, maxLines: null, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(hintText: 'What should the team and the AI know?')),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _kind,
                decoration: const InputDecoration(labelText: 'Type', isDense: true),
                items: [for (final k in knowledgeKinds) DropdownMenuItem(value: k, child: Text(cap(k)))],
                onChanged: (v) => setState(() => _kind = v ?? 'fact'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: DropdownButtonFormField<String?>(
                initialValue: cats.any((k) => k['id'] == _category) ? _category : null,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Category', isDense: true),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('Inbox')),
                  for (final k in cats.where((k) => k['key'] != 'inbox')) DropdownMenuItem<String?>(value: k['id'] as String, child: Text(k['name'] as String, overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => setState(() => _category = v),
              ),
            ),
          ]),
          if (!_editing) ...[
            const SizedBox(height: 12),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _shared,
              onChanged: (v) => setState(() => _shared = v),
              title: const Text('Share with the workspace'),
              subtitle: Text(_shared ? 'Everyone here and their agents can read it.' : 'Only you can see it. Your agents use it only in your own chats.', style: qs(13, c: c.text3)),
            ),
          ],
        ]),
      ),
    );
  }
}
