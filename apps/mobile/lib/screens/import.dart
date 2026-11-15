import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class ImportScreen extends ConsumerStatefulWidget {
  const ImportScreen({super.key});
  @override
  ConsumerState<ImportScreen> createState() => _ImportState();
}

class _ImportState extends ConsumerState<ImportScreen> {
  bool _uploading = false;

  Future<void> _pick() async {
    final files = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['csv', 'xlsx', 'json', 'txt', 'md', 'pdf', 'docx']);
    if (files.isEmpty || !mounted) return;
    final f = files.first;
    setState(() => _uploading = true);
    try {
      final bytes = await f.readAsBytes();
      if (bytes.length > 10 * 1024 * 1024) {
        if (mounted) toast(context, 'That file is over 10 MB. Split it and try again.');
        return;
      }
      final r = await ref.read(apiProvider).upload('/files', f.name, bytes) as Map;
      ref.read(refreshTick.notifier).bump();
      if (!mounted) return;
      if (r['note'] != null) toast(context, r['note'] as String);
      push(context, ImportDetail(id: (r['import'] as Map)['id'] as String));
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Page2(
      title: 'Import data',
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/imports')),
        builder: (context, list, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          QCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Bring your data in', style: qs(16, w: FontWeight.w600, c: q.text)),
              const SizedBox(height: 4),
              Text('Spreadsheets (CSV, XLSX, JSON) become contacts, companies or tasks — you choose the columns. Documents (PDF, DOCX, TXT, MD) go to your Library. Up to 10 MB. Every import can be rolled back.', style: qs(13, c: q.text2)),
              const SizedBox(height: 14),
              QButton('Choose a file', icon: Icons.upload_file, expand: true, busy: _uploading, onPressed: canWrite ? _pick : null),
            ]),
          ),
          SectionLabel('Past imports (${list.length})'),
          if (list.isEmpty) Text('Nothing imported yet.', style: qs(14, c: q.text3)),
          for (final j in list)
            ListTile(
              contentPadding: EdgeInsets.zero,
              onTap: () => push(context, ImportDetail(id: j['id'] as String)),
              title: Text(j['file_name'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text('${cap(j['target_entity'] as String? ?? '')} · ${j['rows_ok']} imported · ${ago(j['created_at'] as String?)}'),
              trailing: StatusPill(j['status'] as String),
            ),
        ]),
      ),
    );
  }
}

class ImportDetail extends ConsumerStatefulWidget {
  const ImportDetail({super.key, required this.id});
  final String id;
  @override
  ConsumerState<ImportDetail> createState() => _ImportDetailState();
}

class _ImportDetailState extends ConsumerState<ImportDetail> {
  String? _target;
  Map<String, String> _fields = {};
  String _dupes = 'skip';
  bool _busy = false;
  String? _loadedFor;

  void _seed(Map j) {
    final key = '${j['status']}';
    if (_loadedFor == key) return;
    _loadedFor = key;
    final m = (j['mapping'] as Map?) ?? {};
    _target = (m['target'] as String?) ?? (j['target_entity'] as String?);
    _fields = ((m['fields'] as Map?) ?? {}).map((k, v) => MapEntry('$k', '$v'));
    _dupes = (m['duplicates'] as String?) ?? 'skip';
  }

  Future<void> _run(Map j, Future<void> Function() reload) async {
    setState(() => _busy = true);
    final api = ref.read(apiProvider);
    try {
      if (_target != 'documents') {
        if (_fields.isEmpty) {
          toast(context, 'Match at least one column first.');
          return;
        }
        await api.put('/imports/${widget.id}/mapping', {'target': _target, 'fields': _fields, 'duplicates': _dupes});
      }
      final r = await api.post('/imports/${widget.id}/run') as Map;
      ref.read(refreshTick.notifier).bump();
      if (mounted) toast(context, 'Imported ${r['rows_ok']} · skipped ${r['rows_skipped']} · failed ${r['rows_failed']}');
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
      await reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Import',
      body: Load<Map>(
        fetch: (api) async => await api.get('/imports/${widget.id}') as Map,
        builder: (context, j, reload) {
          _seed(j);
          final status = j['status'] as String;
          final isDoc = j['target_entity'] == 'documents';
          final columns = ((j['columns'] as List?) ?? const []).map((e) => '$e').toList();
          final targets = ((j['targets'] as Map?) ?? {}).map((k, v) => MapEntry('$k', (v as List).map((e) => '$e').toList()));
          final preview = items(j['preview']);
          final editable = status == 'parsed' || status == 'mapped';
          final errors = items(j['errors']);
          return ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [StatusPill(status), const SizedBox(width: 10), Text(j['format'].toString().toUpperCase(), style: qs(12, c: q.text3, family: mono))]),
            const SizedBox(height: 10),
            Text(j['file_name'] as String, style: Theme.of(context).textTheme.titleLarge),
            Text(isDoc ? 'Document → Library' : '${j['rows_total']} rows · ${columns.length} columns', style: qs(14, c: q.text2)),
            if (status == 'completed' || status == 'rolled_back') ...[
              const SectionLabel('Result'),
              QCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  KV('Imported', '${j['rows_ok']}'),
                  KV('Skipped (duplicates)', '${j['rows_skipped']}'),
                  KV('Failed', '${j['rows_failed']}'),
                  for (final e in errors.take(10)) Text('Row ${e['row']}: ${e['message']}', style: qs(12, c: q.bad)),
                ]),
              ),
              if (status == 'completed') ...[
                const SizedBox(height: 12),
                QButton('Roll back this import', kind: QBtn.destructive, expand: true, onPressed: () async {
                  if (await confirm(context, title: 'Roll back import?', body: 'Removes the ${j['rows_ok']} records this import created. Records edited since then are kept.', action: 'Roll back', destructive: true)) {
                    if (context.mounted) await act(context, ref, (api) => api.post('/imports/${widget.id}/rollback'), ok: 'Rolled back');
                    await reload();
                  }
                }),
              ],
            ],
            if (editable && !isDoc) ...[
              const SectionLabel('Import as'),
              SegmentedButton<String>(
                segments: [for (final t in targets.keys) ButtonSegment(value: t, label: Text(cap(t)))],
                selected: {_target ?? 'contacts'},
                onSelectionChanged: (s) => setState(() {
                  _target = s.first;
                  _fields = {};
                }),
              ),
              const SectionLabel('Match columns'),
              Text('Suggested automatically from column names. Check each one.', style: qs(13, c: q.text3)),
              const SizedBox(height: 8),
              for (final f in targets[_target] ?? const <String>[])
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(children: [
                    SizedBox(width: 110, child: Text(f, style: qs(14, w: FontWeight.w500, c: q.text))),
                    Expanded(
                      child: DropdownButtonFormField<String>(
                        initialValue: columns.contains(_fields[f]) ? _fields[f] : '',
                        isExpanded: true,
                        decoration: const InputDecoration(isDense: true),
                        items: [DropdownMenuItem(value: '', child: Text('Don\'t import', style: qs(14, c: q.text3))), for (final c in columns) DropdownMenuItem(value: c, child: Text(c, overflow: TextOverflow.ellipsis))],
                        onChanged: (v) => setState(() => (v == null || v.isEmpty) ? _fields.remove(f) : _fields[f] = v),
                      ),
                    ),
                  ]),
                ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Skip duplicates'),
                subtitle: const Text('Matches on email for contacts, name for companies, title for tasks'),
                value: _dupes == 'skip',
                onChanged: (v) => setState(() => _dupes = v ? 'skip' : 'create'),
              ),
            ],
            if (preview.isNotEmpty) ...[
              SectionLabel(isDoc ? 'Text preview' : 'Preview (first ${preview.length} rows)'),
              isDoc
                  ? QCard(child: Text('${preview.first['text']}', maxLines: 16, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2)))
                  : SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: DataTable(
                        headingTextStyle: qs(12, w: FontWeight.w600, c: q.text2),
                        dataTextStyle: qs(12, c: q.text),
                        columns: [for (final c in columns) DataColumn(label: Text(c))],
                        rows: [for (final r in preview) DataRow(cells: [for (final c in columns) DataCell(Text('${r[c] ?? ''}'))])],
                      ),
                    ),
            ],
            if (editable) ...[
              const SizedBox(height: 20),
              QButton(isDoc ? 'Add to Library' : 'Import ${j['rows_total']} rows', kind: QBtn.halo, expand: true, busy: _busy, onPressed: () => _run(j, reload)),
            ],
          ]);
        },
      ),
    );
  }
}
