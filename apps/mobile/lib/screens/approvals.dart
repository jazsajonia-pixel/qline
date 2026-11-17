import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../ui/theme.dart';
import '../ui/widgets.dart';

Map<String, dynamic> _preview(Map a) {
  final p = a['preview'];
  if (p is Map) return p.cast<String, dynamic>();
  if (p is String) {
    try {
      return (jsonDecode(p) as Map).cast<String, dynamic>();
    } catch (_) {}
  }
  return {};
}

String approvalTitle(Map a) => (_preview(a)['title'] as String?) ?? cap((a['action'] as String? ?? 'Action').replaceAll('.', ' '));

class ApprovalsScreen extends StatefulWidget {
  const ApprovalsScreen({super.key});
  @override
  State<ApprovalsScreen> createState() => _ApprovalsState();
}

class _ApprovalsState extends State<ApprovalsScreen> {
  String _status = 'pending';
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Approvals',
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SegmentedButton<String>(
              segments: const [ButtonSegment(value: 'pending', label: Text('Waiting')), ButtonSegment(value: 'all', label: Text('History'))],
              selected: {_status},
              onSelectionChanged: (s) => setState(() => _status = s.first),
            ),
          ),
        ),
        Expanded(
          child: Load<List<Map<String, dynamic>>>(
            key: ValueKey(_status),
            fetch: (api) async => items(await api.get('/approvals', {'status': _status})),
            builder: (context, list, reload) => list.isEmpty
                ? EmptyState(icon: Icons.verified_user_outlined, title: _status == 'pending' ? 'Nothing waiting' : 'No approvals yet', body: 'When an agent or workflow wants to do something risky, it asks here first.')
                : RefreshIndicator(
                    onRefresh: reload,
                    child: ListView.separated(
                      padding: const EdgeInsets.all(16),
                      itemCount: list.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final a = list[i];
                        return QCard(
                          onTap: () => push(context, ApprovalDetail(id: a['id'] as String)),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [Expanded(child: Text(approvalTitle(a), style: qs(15, w: FontWeight.w600, c: q.text))), StatusPill(a['status'] as String)]),
                            const SizedBox(height: 6),
                            Row(children: [
                              Icon(a['requester_kind'] == 'workflow' ? Icons.account_tree_outlined : Icons.smart_toy_outlined, size: 14, color: q.text3),
                              const SizedBox(width: 4),
                              Flexible(child: Text('${a['requester_name'] ?? cap(a['requester_kind'] as String? ?? '')} · ${ago(a['created_at'] as String?)}', style: qs(12, c: q.text3))),
                              const SizedBox(width: 10),
                              RiskTag(a['risk'] as String?),
                            ]),
                          ]),
                        );
                      },
                    ),
                  ),
          ),
        ),
      ]),
    );
  }
}

class ApprovalDetail extends ConsumerStatefulWidget {
  const ApprovalDetail({super.key, required this.id});
  final String id;
  @override
  ConsumerState<ApprovalDetail> createState() => _ApprovalDetailState();
}

class _ApprovalDetailState extends ConsumerState<ApprovalDetail> {
  String? _busy;
  final _note = TextEditingController();

  Future<void> _decide(String decision, Future<void> Function() reload) async {
    setState(() => _busy = decision);
    final r = await act(context, ref, (api) => api.post('/approvals/${widget.id}/decision', {'decision': decision, if (_note.text.trim().isNotEmpty) 'note': _note.text.trim()}),
        ok: decision == 'approve' ? 'Approved' : 'Rejected. Nothing was changed.');
    if (mounted) setState(() => _busy = null);
    if (r != null && mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Approval',
      body: Load<Map>(
        fetch: (api) async => await api.get('/approvals/${widget.id}') as Map,
        builder: (context, a, reload) {
          final p = _preview(a);
          final lines = (p['lines'] as List?)?.cast<Object?>() ?? const [];
          final args = p['args'] is Map ? (p['args'] as Map) : const {};
          final pending = a['status'] == 'pending';
          final canDecide = a['canDecide'] == true;
          return ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [StatusPill(a['status'] as String), const SizedBox(width: 10), RiskTag(a['risk'] as String?)]),
            const SizedBox(height: 12),
            Text(approvalTitle(a), style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 6),
            Text('Requested by ${p['agent'] ?? cap(a['requester_kind'] as String? ?? 'agent')} · ${ago(a['created_at'] as String?)}', style: qs(13, c: q.text3)),
            const SectionLabel('What will happen'),
            QCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (lines.isEmpty) Text(cap((a['action'] as String).replaceAll('.', ' ')), style: qs(14, c: q.text)),
                for (final l in lines) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('$l', style: qs(14, c: q.text))),
              ]),
            ),
            if (a['reason'] != null) ...[const SectionLabel('Why approval is needed'), Text('${a['reason']}', style: qs(14, c: q.text2))],
            if (args.isNotEmpty) ...[
              const SectionLabel('Exact inputs'),
              QCard(child: SelectableText(const JsonEncoder.withIndent('  ').convert(args), style: qs(12, c: q.text2, family: mono))),
            ],
            const SectionLabel('Expires'),
            Text(dateLabel(a['expires_at'] as String?), style: qs(14, c: q.text2)),
            if (a['decision_note'] != null) ...[const SectionLabel('Decision note'), Text('${a['decision_note']}', style: qs(14, c: q.text2))],
            if (pending) ...[
              const SizedBox(height: 20),
              if (!canDecide)
                QCard(child: Text('Your role can\'t decide this request. An owner or admin needs to review it.', style: qs(14, c: q.text2)))
              else ...[
                TextField(controller: _note, decoration: const InputDecoration(labelText: 'Note (optional)')),
                const SizedBox(height: 16),
                Row(children: [
                  Expanded(child: QButton('Reject', kind: QBtn.destructive, busy: _busy == 'reject', onPressed: _busy == null ? () => _decide('reject', reload) : null)),
                  const SizedBox(width: 12),
                  Expanded(child: QButton('Approve', kind: QBtn.halo, icon: Icons.check, busy: _busy == 'approve', onPressed: _busy == null ? () => _decide('approve', reload) : null)),
                ]),
              ],
            ],
          ]);
        },
      ),
    );
  }
}
