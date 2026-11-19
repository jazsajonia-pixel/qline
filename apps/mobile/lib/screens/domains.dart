import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../ui/theme.dart';
import '../ui/widgets.dart';

/// Phase 7 (ADR-1): domains are labels inside a space (Personal, Work, Learning, ...). Rename, hide or add your own.
/// Tasks can carry a domain; nothing is moved or shared between spaces.
const domainIcons = <String, IconData>{
  'person': Icons.person_outline,
  'work': Icons.work_outline,
  'school': Icons.school_outlined,
  'folder': Icons.folder_outlined,
  'favorite': Icons.favorite_border,
  'savings': Icons.savings_outlined,
  'home': Icons.home_outlined,
  'music_note': Icons.music_note_outlined,
  'label': Icons.label_outline,
};

class DomainsScreen extends ConsumerStatefulWidget {
  const DomainsScreen({super.key});
  @override
  ConsumerState<DomainsScreen> createState() => _DomainsState();
}

class _DomainsState extends ConsumerState<DomainsScreen> {
  int _gen = 0;

  Future<void> _add() async {
    final name = await promptText(context, title: 'New domain', label: 'Name, for example Music or Side project', action: 'Add');
    if (name == null || name.isEmpty || !mounted) return;
    final r = await act(context, ref, (api) => api.post('/domains', {'name': name}), ok: 'Added $name');
    if (r != null && mounted) setState(() => _gen++);
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Domains',
      fab: FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.add), label: const Text('Add domain')),
      body: Load<List<Map<String, dynamic>>>(
        key: ValueKey(_gen),
        fetch: (api) async => items(await api.get('/domains')),
        builder: (context, list, reload) {
          if (list.isEmpty) {
            return const EmptyState(icon: Icons.label_outline, title: 'No domains yet', body: 'Add areas like Work, Learning or Health to group your tasks.');
          }
          return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 96), children: [
            Text('Hidden domains keep their tasks; they just stop showing as a choice.', style: qs(13, c: q.text3)),
            const SizedBox(height: 12),
            for (final d in list)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: QCard(
                  padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
                  child: Row(children: [
                    Icon(domainIcons[d['icon']] ?? Icons.label_outline, color: d['enabled'] == true ? q.text2 : q.text3),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(d['name'] as String? ?? '', style: qs(15, w: FontWeight.w600, c: d['enabled'] == true ? q.text : q.text3)),
                        Text('${d['open_tasks'] ?? 0} open tasks${d['enabled'] == true ? '' : ' · Hidden'}', style: qs(12, c: q.text3)),
                      ]),
                    ),
                    IconButton(
                      tooltip: 'Rename ${d['name']}',
                      icon: const Icon(Icons.edit_outlined, size: 18),
                      onPressed: () async {
                        final n = await promptText(context, title: 'Rename domain', initial: d['name'] as String?, action: 'Save');
                        if (n == null || n.isEmpty || !context.mounted) return;
                        await act(context, ref, (api) => api.patch('/domains/${d['id']}', {'name': n}));
                        await reload();
                      },
                    ),
                    Switch(
                      value: d['enabled'] == true,
                      onChanged: (v) async {
                        await act(context, ref, (api) => api.patch('/domains/${d['id']}', {'enabled': v}));
                        await reload();
                      },
                    ),
                  ]),
                ),
              ),
          ]);
        },
      ),
    );
  }
}
