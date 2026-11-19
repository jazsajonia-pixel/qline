import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

/// Built-in profiles a custom agent can be based on. The profile only bounds which tools it may ever use.
const agentProfiles = {
  'research': 'Research — reads and looks things up',
  'operations': 'Operations — tasks, projects, notes',
  'sales': 'Sales — contacts, pipeline, follow-ups',
  'marketing': 'Marketing — content and campaigns',
  'finance': 'Finance — invoices and reports',
  'ceo': 'Chief of Staff — a bit of everything',
};

/// Phase 4 / M9: create or edit one of your own agents. Returns the agent id when saved.
/// [agent] edits an existing agent; [cloneFrom] starts a copy of another one.
Future<String?> showAgentEditor(BuildContext context, {Map? agent, Map? cloneFrom}) =>
    push<String>(context, AgentEditor(agent: agent, cloneFrom: cloneFrom));

class AgentEditor extends ConsumerStatefulWidget {
  const AgentEditor({super.key, this.agent, this.cloneFrom});
  final Map? agent;
  final Map? cloneFrom;
  @override
  ConsumerState<AgentEditor> createState() => _AgentEditorState();
}

class _AgentEditorState extends ConsumerState<AgentEditor> {
  late final Map? _a = widget.agent;
  late final Map? _src = widget.cloneFrom;
  late final bool _custom = _a == null || _a['template'] == 'custom';
  late final _name = TextEditingController(text: _a?['name'] as String? ?? (_src != null ? 'Copy of ${_src['name']}' : ''));
  late final _desc = TextEditingController(text: _a?['description'] as String? ?? _src?['description'] as String? ?? '');
  late final _instr = TextEditingController(text: _a?['instructions'] as String? ?? _src?['instructions'] as String? ?? '');
  late final _daily = TextEditingController(text: (_a?['daily_runs'] ?? '').toString());
  late String _accent = _a?['accent'] as String? ?? _src?['accent'] as String? ?? 'violet';
  late String _profile = _a?['based_on'] as String? ??
      (_src == null ? 'research' : (_src['template'] == 'custom' ? _src['based_on'] as String? ?? 'research' : _src['template'] as String));
  late bool _askAll = (_a?['approval_mode'] ?? _src?['approval_mode']) == 'ask_all';
  late double _maxTools = ((_a?['max_tool_calls'] ?? _src?['max_tool_calls'] ?? 8) as num).toDouble();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _desc, _instr, _daily]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final instructions = _instr.text.trim();
    if (name.isEmpty || instructions.isEmpty) {
      setState(() => _error = 'Give it a name and instructions.');
      return;
    }
    final daily = int.tryParse(_daily.text.trim());
    setState(() {
      _busy = true;
      _error = null;
    });
    final body = <String, dynamic>{
      'name': name,
      'instructions': instructions,
      'approvalMode': _askAll ? 'ask_all' : 'policy',
      'maxToolCalls': _maxTools.round(),
      'dailyRuns': daily != null && daily > 0 ? daily : null,
      if (_custom) 'description': _desc.text.trim(),
      if (_custom) 'accent': _accent,
    };
    try {
      final api = ref.read(apiProvider);
      final Map r;
      if (_a != null) {
        r = await api.patch('/agents/${_a['id']}', body) as Map;
      } else {
        if (body['dailyRuns'] == null) body.remove('dailyRuns');
        r = await api.post('/agents', {...body, 'basedOn': _profile, if (_src != null) 'cloneFrom': _src['id']}) as Map;
      }
      if (!mounted) return;
      ref.read(refreshTick.notifier).bump();
      toast(context, _a == null ? 'Created. It starts paused — try it with Preview, then activate it.' : 'Saved as a new version');
      Navigator.pop(context, r['id'] as String?);
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e is ApiException ? e.message : 'Something went wrong.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final editing = _a != null;
    return Page2(
      title: editing ? 'Edit agent' : (_src != null ? 'Duplicate agent' : 'New agent'),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _name, maxLength: 80, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(labelText: 'Name', counterText: '')),
        if (_custom) ...[
          const SizedBox(height: 12),
          TextField(controller: _desc, maxLength: 300, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(labelText: 'What it is for (optional)', counterText: '')),
          const SectionLabel('Colour'),
          Wrap(spacing: 10, runSpacing: 10, children: [
            for (final e in AgentStyle.accents.entries)
              Semantics(
                button: true,
                selected: _accent == e.key,
                label: e.key,
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: () => setState(() => _accent = e.key),
                  child: Container(
                    width: 48,
                    height: 48,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: _accent == e.key ? q.text : Colors.transparent, width: 2)),
                    child: Container(width: 32, height: 32, decoration: BoxDecoration(shape: BoxShape.circle, color: e.value)),
                  ),
                ),
              ),
          ]),
        ],
        if (!editing) ...[
          const SectionLabel('Based on'),
          DropdownButtonFormField<String>(
            initialValue: _profile,
            isExpanded: true,
            items: [for (final e in agentProfiles.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))],
            onChanged: (v) => setState(() => _profile = v ?? _profile),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              _src == null
                  ? 'It starts with read-only tools from this profile. You can add more of the profile\'s tools later; never others.'
                  : 'It keeps the tools of the agent you are copying.',
              style: qs(12, c: q.text3, h: 1.4),
            ),
          ),
        ],
        const SectionLabel('Instructions'),
        TextField(
          controller: _instr,
          minLines: 5,
          maxLines: 14,
          maxLength: 8000,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(hintText: 'What it should help with, and how. For example: "Quiz me on my class notes, one question at a time."'),
        ),
        const SectionLabel('Safety and limits'),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _askAll,
          onChanged: (v) => setState(() => _askAll = v),
          title: Text('Ask before every change', style: qs(15, w: FontWeight.w600, c: q.text)),
          subtitle: Text('Looking things up still runs on its own; anything that changes your data waits for your approval.', style: qs(12, c: q.text3, h: 1.4)),
        ),
        const SizedBox(height: 8),
        Text('Steps per answer: ${_maxTools.round()}${_maxTools.round() == 0 ? ' (chat only, no tools)' : ''}', style: qs(14, c: q.text)),
        Slider(value: _maxTools, min: 0, max: 8, divisions: 8, label: '${_maxTools.round()}', onChanged: (v) => setState(() => _maxTools = v)),
        TextField(
          controller: _daily,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(labelText: 'Answers per day (optional)', hintText: 'No limit'),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: qs(13, c: q.bad))),
        const SizedBox(height: 20),
        QButton(editing ? 'Save' : 'Create agent', kind: QBtn.halo, busy: _busy, onPressed: _busy ? null : _save),
        const SizedBox(height: 8),
        Text(
          editing ? 'Every save is a new version you can go back to.' : 'New agents start paused, so nothing runs until you activate it.',
          textAlign: TextAlign.center,
          style: qs(12, c: q.text3),
        ),
      ]),
    );
  }
}

/// Try an agent on one message, without tools and without saving anything.
Future<void> showAgentPreview(BuildContext context, Map agent) =>
    showModalBottomSheet(context: context, isScrollControlled: true, builder: (_) => _PreviewSheet(agent: agent));

class _PreviewSheet extends ConsumerStatefulWidget {
  const _PreviewSheet({required this.agent});
  final Map agent;
  @override
  ConsumerState<_PreviewSheet> createState() => _PreviewSheetState();
}

class _PreviewSheetState extends ConsumerState<_PreviewSheet> {
  final _c = TextEditingController();
  bool _busy = false;
  String? _reply;
  String? _meta;
  String? _error;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final m = _c.text.trim();
    if (m.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await ref.read(apiProvider).post('/agents/${widget.agent['id']}/preview', {'message': m}) as Map;
      if (!mounted) return;
      setState(() {
        _busy = false;
        if (r['ok'] == true) {
          _reply = r['reply'] as String?;
          _meta = [r['model'], if (r['key'] != null) r['key'], '${r['latencyMs']} ms'].join(' · ');
        } else {
          _error = r['message'] as String? ?? 'The model did not answer.';
        }
      });
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e is ApiException ? e.message : 'Something went wrong.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Preview ${widget.agent['name']}', style: qs(18, w: FontWeight.w600, c: q.text)),
        const SizedBox(height: 4),
        Text('A test answer without tools. Nothing is saved or changed.', style: qs(13, c: q.text2)),
        const SizedBox(height: 12),
        TextField(
          controller: _c,
          autofocus: true,
          maxLength: 2000,
          minLines: 1,
          maxLines: 4,
          decoration: const InputDecoration(labelText: 'Message', counterText: ''),
          onSubmitted: (_) => _send(),
        ),
        const SizedBox(height: 10),
        Align(alignment: Alignment.centerRight, child: QButton('Try it', kind: QBtn.halo, busy: _busy, onPressed: _busy ? null : _send)),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: qs(13, c: q.bad, h: 1.4))),
        if (_reply != null) ...[
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .4),
            child: QCard(child: SingleChildScrollView(child: SelectableText(_reply!, style: qs(14, c: q.text, h: 1.5)))),
          ),
          if (_meta != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_meta!, style: qs(11, c: q.text3, family: mono))),
        ],
      ]),
    );
  }
}

/// Version history with "Restore". Restoring writes a new version; nothing is deleted.
class AgentVersionsScreen extends ConsumerWidget {
  const AgentVersionsScreen({super.key, required this.agentId, required this.canManage});
  final String agentId;
  final bool canManage;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Page2(
      title: 'Versions',
      body: Load<Map>(
        fetch: (api) async => await api.get('/agents/$agentId') as Map,
        builder: (context, a, reload) {
          final versions = items(a, 'versions');
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: versions.length,
            separatorBuilder: (_, _) => const SizedBox(height: 8),
            itemBuilder: (_, i) {
              final v = versions[i];
              final current = v['version'] == a['current_version'];
              final model = v['provider'] == null ? 'Workspace default model' : '${v['provider']} · ${v['model']}';
              return QCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Text('Version ${v['version']}', style: qs(15, w: FontWeight.w600, c: q.text)),
                    if (current) ...[const SizedBox(width: 8), Text('Current', style: qs(12, w: FontWeight.w600, c: q.ok))],
                    const Spacer(),
                    Text(ago(v['created_at'] as String?), style: qs(12, c: q.text3, family: mono)),
                  ]),
                  const SizedBox(height: 4),
                  Text(v['instructions_preview'] as String? ?? '', maxLines: 3, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2, h: 1.4)),
                  const SizedBox(height: 4),
                  Text(
                    [model, if (v['key_alias'] != null) 'key "${v['key_alias']}"', if (v['approval_mode'] == 'ask_all') 'asks before every change', '${v['max_tool_calls']} steps'].join(' · '),
                    style: qs(12, c: q.text3),
                  ),
                  if (canManage && !current)
                    Align(
                      alignment: Alignment.centerRight,
                      child: QButton('Restore', kind: QBtn.ghost, icon: Icons.restore, onPressed: () async {
                        final r = await act(context, ref, (api) => api.post('/agents/$agentId/revert', {'version': v['version']}), ok: 'Restored as a new version');
                        if (r is Map && r['keyDropped'] == true && context.mounted) toast(context, 'Restored. The key it used was removed, so it uses automatic routing.');
                        await reload();
                      }),
                    ),
                ]),
              );
            },
          );
        },
      ),
    );
  }
}
