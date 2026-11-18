import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../ui/theme.dart';
import '../ui/widgets.dart';

/// Run 3 (docs/19, M1 follow-up): actions in connected apps that were interrupted, so Qline cannot tell
/// whether they happened. They are never retried on their own. The person checks the app (Slack, Gmail,
/// Calendar…) and records the real outcome here; that record is kept for auditing.
class NeedsCheckingScreen extends ConsumerWidget {
  const NeedsCheckingScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Page2(
      title: 'Needs checking',
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/actions/unknown')),
        builder: (context, list, reload) => list.isEmpty
            ? const EmptyState(
                icon: Icons.fact_check_outlined,
                title: 'Nothing to check',
                body: 'When an action in a connected app is interrupted and Qline cannot tell whether it went through, it shows up here.',
              )
            : RefreshIndicator(
                onRefresh: reload,
                child: ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: list.length + 1,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (_, i) => i == 0
                      ? Text('Qline will not try these again on its own. Check the app, then record what happened.', style: qs(13, c: context.q.text2, h: 1.4))
                      : _UnknownAction(a: list[i - 1], reload: reload),
                ),
              ),
      ),
    );
  }
}

class _UnknownAction extends ConsumerStatefulWidget {
  const _UnknownAction({required this.a, required this.reload});
  final Map<String, dynamic> a;
  final Future<void> Function() reload;
  @override
  ConsumerState<_UnknownAction> createState() => _UnknownActionState();
}

class _UnknownActionState extends ConsumerState<_UnknownAction> {
  String? _busy;

  Future<void> _resolve(String resolution) async {
    final done = resolution == 'done';
    final ok = await confirm(
      context,
      title: done ? 'Mark as done?' : 'Mark as not done?',
      body: done ? 'Only if you checked and it really went through.' : 'Only if you checked and it did not go through. Qline will not send it again; ask again in chat if you still want it.',
      action: done ? 'It happened' : 'It did not happen',
    );
    if (!ok || !mounted) return;
    setState(() => _busy = resolution);
    await act(context, ref, (api) => api.post('/actions/${widget.a['id']}/resolve', {'resolution': resolution}), ok: 'Recorded');
    if (mounted) setState(() => _busy = null);
    await widget.reload();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final a = widget.a;
    return QCard(
      accent: q.warn.withValues(alpha: .5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.help_outline, size: 18, color: q.warn),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  a['title'] as String? ?? 'An action',
                  style: qs(15, w: FontWeight.w600, c: q.text),
                ),
              ),
              RiskTag(a['risk'] as String?),
            ],
          ),
          for (final l in (a['lines'] as List? ?? const []))
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '$l',
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: qs(13, c: q.text2),
              ),
            ),
          const SizedBox(height: 6),
          Text('${a['summary'] ?? 'Not sure this happened.'} · ${ago(a['created_at'] as String?)}', style: qs(12, c: q.text3)),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              QButton('It happened', icon: Icons.check, busy: _busy == 'done', onPressed: _busy == null ? () => _resolve('done') : null),
              QButton('It did not happen', icon: Icons.close, busy: _busy == 'not_done', onPressed: _busy == null ? () => _resolve('not_done') : null),
            ],
          ),
        ],
      ),
    );
  }
}
