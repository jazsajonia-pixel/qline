import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'missions.dart';

/// Phase 6 (M8): things the AI proposed — a mission or a change to an agent. Nothing happens until you approve.
/// Applying runs through the same checks as doing it by hand, so the AI can never change more than you could.

/// Who did what, in plain words.
String proposalState(String? s) => switch (s) {
      'proposed' => 'Proposed by AI',
      'edited' => 'Edited by you',
      'applied' => 'Applied',
      'rejected' => 'Rejected',
      'failed' => 'Could not apply',
      _ => s ?? '',
    };

/// A short list of open proposals (missions on the Missions screen, agent changes on the team screen).
class ProposalsSection extends StatelessWidget {
  const ProposalsSection({super.key, required this.kind, this.onChanged});
  final String kind;
  final VoidCallback? onChanged;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Load<List>(
      // Sits inside other lists: no list skeleton, and a failure (or an older server without proposals) just hides it.
      skeleton: const SizedBox.shrink(),
      fetch: (api) async {
        try {
          return items(await api.get('/proposals', {'kind': kind}));
        } on ApiException {
          return const [];
        }
      },
      builder: (context, list, reload) {
        if (list.isEmpty) return const SizedBox.shrink();
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SectionLabel(kind == 'mission' ? 'Proposed missions' : 'Proposed agent changes'),
          for (final p in list)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: QCard(
                accent: q.halo.withValues(alpha: .5),
                onTap: () async {
                  await push(context, ProposalScreen(id: p['id'] as String));
                  await reload();
                  onChanged?.call();
                },
                child: Row(children: [
                  Icon(kind == 'mission' ? Icons.flag_outlined : Icons.tune, color: q.halo),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(p['title'] as String? ?? '', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
                      const SizedBox(height: 4),
                      Text('${proposalState(p['status'] as String?)} · Review before anything changes', style: qs(12, c: q.text3)),
                    ]),
                  ),
                  Icon(Icons.chevron_right, color: q.text3),
                ]),
              ),
            ),
          const SizedBox(height: 8),
        ]);
      },
    );
  }
}

/// One proposal: what would change, with edit, approve and reject.
class ProposalScreen extends ConsumerStatefulWidget {
  const ProposalScreen({super.key, required this.id});
  final String id;
  @override
  ConsumerState<ProposalScreen> createState() => _ProposalScreenState();
}

class _ProposalScreenState extends ConsumerState<ProposalScreen> {
  String? _busy;

  Future<void> _do(String key, Future<dynamic> Function(Api api) fn, String ok, Future<void> Function() reload) async {
    setState(() => _busy = key);
    await act(context, ref, fn, ok: ok);
    if (mounted) setState(() => _busy = null);
    await reload();
  }

  Future<void> _editField(Map p, String field, String title, {bool list = false, int maxLines = 3}) async {
    final payload = Map<String, dynamic>.from(p['payload'] as Map);
    final cur = payload[field];
    final initial = list ? ((cur as List?) ?? const []).join('\n') : (cur ?? '').toString();
    final v = await promptText(context, title: title, label: list ? 'One per line' : null, initial: initial, maxLines: maxLines);
    if (v == null || !mounted) return;
    if (list) {
      final lines = v.split('\n').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
      if (lines.isEmpty) {
        payload.remove(field);
      } else {
        payload[field] = lines;
      }
    } else if (v.isEmpty) {
      payload.remove(field);
    } else {
      payload[field] = v;
    }
    await act(context, ref, (api) => api.patch('/proposals/${widget.id}', {'revision': p['revision'], 'payload': payload}), ok: 'Saved. Review it, then approve.');
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Review proposal',
      body: Load<Map>(
        fetch: (api) async => await api.get('/proposals/${widget.id}') as Map,
        builder: (context, p, reload) {
          final open = const ['proposed', 'edited', 'failed'].contains(p['status']);
          final canApply = p['canApply'] == true;
          final isMission = p['kind'] == 'mission';
          final payload = (p['payload'] as Map?) ?? const {};
          Future<void> edit(String f, String t, {bool list = false, int maxLines = 3}) async {
            await _editField(p, f, t, list: list, maxLines: maxLines);
            await reload();
          }

          return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
            Row(children: [
              Expanded(child: Text(p['title'] as String? ?? '', style: qs(20, w: FontWeight.w600, c: q.text))),
              const SizedBox(width: 8),
              StatusPill(p['status'] as String? ?? ''),
            ]),
            const SizedBox(height: 6),
            Text('${proposalState(p['status'] as String?)} · ${ago(p['created_at'] as String?)}', style: qs(12, c: q.text3)),
            if (p['status'] == 'failed' && p['error'] != null) ...[
              const SizedBox(height: 12),
              QCard(accent: q.bad, child: Text('Could not apply: ${p['error']}', style: qs(13, c: q.text))),
            ],
            const SizedBox(height: 16),
            if (isMission) ...[
              _Field('Title', payload['title'] as String?, open && canApply ? () => edit('title', 'Title', maxLines: 1) : null),
              _Field('Purpose', payload['purpose'] as String?, open && canApply ? () => edit('purpose', 'Purpose', maxLines: 5) : null),
              _Field('Scope', payload['scope'] as String?, open && canApply ? () => edit('scope', 'Scope') : null),
              _Field('Constraints', _lines(payload['constraints']), open && canApply ? () => edit('constraints', 'Constraints', list: true, maxLines: 6) : null),
              _Field('Success criteria', _lines(payload['successCriteria']), open && canApply ? () => edit('successCriteria', 'Success criteria', list: true, maxLines: 6) : null),
              _Field('Timing', payload['timing'] as String?, open && canApply ? () => edit('timing', 'Timing', maxLines: 1) : null),
              _Field('Preferred specialists', ((payload['agents'] as List?) ?? const []).map((e) => cap('$e')).join(', '), null),
              _Field(
                'Budget',
                '${payload['budgetToolCalls'] ?? 60} tool calls · ${payload['budgetTokens'] ?? 200000} tokens · ${(((payload['budgetWallSeconds'] ?? 3600) as num) / 60).round()} min · ${payload['maxParallel'] ?? 2} at a time',
                null,
              ),
              const SizedBox(height: 4),
              Text('Approving creates the mission. Command Center then plans it, and you approve that plan before any task runs.', style: qs(12, c: q.text3)),
            ] else
              _AgentDiff(p['diff'] as Map?, reason: payload['reason'] as String?),
            const SizedBox(height: 20),
            if (open && !canApply)
              Text('Only an owner or admin can apply this change.', style: qs(13, c: q.text2))
            else if (open)
              Row(children: [
                Expanded(
                  child: QButton('Reject', kind: QBtn.destructive, busy: _busy == 'reject', onPressed: _busy != null ? null : () => _do('reject', (api) => api.post('/proposals/${widget.id}/reject', {}), 'Rejected. Nothing changed.', reload)),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: QButton(
                    isMission ? 'Approve and create' : 'Approve change',
                    kind: QBtn.halo,
                    busy: _busy == 'apply',
                    onPressed: _busy != null
                        ? null
                        : () => _do('apply', (api) => api.post('/proposals/${widget.id}/apply', {'revision': p['revision']}), isMission ? 'Mission created. Command Center is planning it.' : 'Agent updated. You can revert it under Versions.', reload),
                  ),
                ),
              ]),
            if (p['status'] == 'applied' && isMission && (p['applied_ref'] as String?)?.startsWith('mission:') == true) ...[
              const SizedBox(height: 8),
              QButton('Open mission', expand: true, onPressed: () => push(context, MissionDetail(id: (p['applied_ref'] as String).substring(8)))),
            ],
          ]);
        },
      ),
    );
  }
}

String? _lines(Object? v) => v is List && v.isNotEmpty ? v.map((e) => '• $e').join('\n') : null;

class _Field extends StatelessWidget {
  const _Field(this.label, this.value, this.onEdit);
  final String label;
  final String? value;
  final VoidCallback? onEdit;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    if ((value == null || value!.isEmpty) && onEdit == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: qs(12, w: FontWeight.w600, c: q.text3)),
            const SizedBox(height: 2),
            Text(value == null || value!.isEmpty ? 'Not set' : value!, style: qs(14, c: value == null || value!.isEmpty ? q.text3 : q.text)),
          ]),
        ),
        if (onEdit != null) IconButton(tooltip: 'Edit $label', icon: const Icon(Icons.edit_outlined, size: 18), onPressed: onEdit),
      ]),
    );
  }
}

/// Before and after for an agent change, with any newly added tool that needs care called out.
class _AgentDiff extends StatelessWidget {
  const _AgentDiff(this.d, {this.reason});
  final Map? d;
  final String? reason;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    if (d == null) return Text('This agent no longer exists.', style: qs(14, c: q.text2));
    final before = (d!['before'] as Map?) ?? const {};
    final after = (d!['after'] as Map?) ?? const {};
    final added = ((d!['added'] as List?) ?? const []).cast<String>();
    final removed = ((d!['removed'] as List?) ?? const []).cast<String>();
    final sensitive = ((d!['sensitive'] as List?) ?? const []).cast<String>();
    Widget change(String label, Object? a, Object? b) => a == b
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: qs(12, w: FontWeight.w600, c: q.text3)),
              const SizedBox(height: 4),
              Text('Now: ${a ?? 'none'}', style: qs(13, c: q.text2)),
              const SizedBox(height: 2),
              Text('After: ${b ?? 'none'}', style: qs(13, w: FontWeight.w600, c: q.text)),
            ]),
          );
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Agent: ${d!['agentName']}', style: qs(14, w: FontWeight.w600, c: q.text)),
      if (reason != null && reason!.isNotEmpty) ...[const SizedBox(height: 4), Text('Why: $reason', style: qs(13, c: q.text2))],
      const SizedBox(height: 12),
      change('Name', before['name'], after['name']),
      change('Description', before['description'], after['description']),
      change('Instructions', before['instructions'], after['instructions']),
      if (added.isNotEmpty) Text('Adds tools: ${added.join(', ')}', style: qs(13, c: q.text)),
      if (removed.isNotEmpty) Text('Removes tools: ${removed.join(', ')}', style: qs(13, c: q.text)),
      if (sensitive.isNotEmpty) ...[
        const SizedBox(height: 8),
        QCard(accent: q.warn, child: Text('These tools can change data or reach outside Qline: ${sensitive.join(', ')}. They still ask for approval when your rules say so.', style: qs(13, c: q.text))),
      ],
      const SizedBox(height: 8),
      Text('Approving saves a new version of the agent. You can revert it under Versions.', style: qs(12, c: q.text3)),
    ]);
  }
}
