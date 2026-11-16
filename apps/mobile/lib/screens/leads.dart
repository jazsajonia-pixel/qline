import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'integrations.dart';

int _n(dynamic v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;

const _sourceIcon = {'gmail': Icons.mail_outline, 'outlook': Icons.mail_outline, 'form': Icons.assignment_outlined, 'sheet': Icons.table_chart_outlined};
const _sourceName = {'gmail': 'Gmail', 'outlook': 'Outlook', 'form': 'Form', 'sheet': 'Sheet'};

/// Everything that came in from connected email, forms and sheets, with the lead / urgency call and why.
class LeadInboxScreen extends ConsumerStatefulWidget {
  const LeadInboxScreen({super.key, this.filter = 'lead'});
  final String filter;
  @override
  ConsumerState<LeadInboxScreen> createState() => _LeadInboxState();
}

class _LeadInboxState extends ConsumerState<LeadInboxScreen> {
  late String _filter = widget.filter;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Lead inbox',
      actions: [
        IconButton(tooltip: 'Lead rules', icon: const Icon(Icons.rule), onPressed: () => push(context, const LeadRulesScreen())),
        IconButton(tooltip: 'Integrations', icon: const Icon(Icons.hub_outlined), onPressed: () => push(context, const IntegrationsScreen())),
      ],
      body: Load<Map<String, dynamic>>(
        key: ValueKey(_filter),
        fetch: (api) async => ((await api.get('/leads/inbox', {'filter': _filter})) as Map).cast<String, dynamic>(),
        builder: (context, d, reload) {
          final counts = (d['counts'] as Map?) ?? const {};
          final list = items(d);
          Widget chip(String id, String label, dynamic count) => Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(label: Text(count == null ? label : '$label · ${_n(count)}'), selected: _filter == id, onSelected: (_) => setState(() => _filter = id)),
              );
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [chip('lead', 'Leads', counts['leads']), chip('urgent', 'Urgent', counts['urgent']), chip('ignored', 'Not leads', counts['ignored']), chip('all', 'All', null)]),
              ),
              const SizedBox(height: 12),
              if (list.isEmpty)
                EmptyState(
                  icon: Icons.inbox_outlined,
                  title: _filter == 'urgent' ? 'Nothing urgent' : 'No messages yet',
                  body: 'Connect Gmail or Outlook, or create a lead form, and new enquiries show up here within 15 minutes.',
                  action: QButton('Integrations', icon: Icons.hub_outlined, onPressed: () => push(context, const IntegrationsScreen())),
                )
              else
                for (final (i, it) in list.indexed) Padding(padding: const EdgeInsets.only(bottom: 10), child: Reveal(index: i, child: _InboxCard(it: it, onChanged: reload))),
              if (list.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Rules and AI decide what counts as a lead. Correct any call and Qline uses your rules next time.', textAlign: TextAlign.center, style: qs(12, c: q.text3))),
            ]),
          );
        },
      ),
    );
  }
}

class _InboxCard extends ConsumerWidget {
  const _InboxCard({required this.it, required this.onChanged});
  final Map<String, dynamic> it;
  final Future<void> Function() onChanged;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final lead = it['is_lead'] == true;
    final src = it['source'] as String? ?? '';
    final who = (it['contact_name'] ?? it['from_name'] ?? it['from_email'] ?? 'Unknown sender') as String;
    return QCard(
      accent: lead && it['urgency'] == 'urgent' ? q.bad.withValues(alpha: .55) : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(_sourceIcon[src] ?? Icons.inbox_outlined, size: 16, color: q.text3),
          const SizedBox(width: 6),
          Text(_sourceName[src] ?? src, style: qs(12, w: FontWeight.w600, c: q.text3)),
          const SizedBox(width: 6),
          Text('· ${ago((it['received_at'] ?? it['created_at']) as String?)}', style: qs(12, c: q.text3)),
          const Spacer(),
          if (lead) UrgencyPill(it['urgency'] as String?) else const StatusPill('ignored'),
        ]),
        const SizedBox(height: 8),
        Text(who, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
        if ((it['subject'] as String?)?.isNotEmpty ?? false) Text(it['subject'] as String, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text)),
        if ((it['summary'] ?? it['snippet']) != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text((it['summary'] ?? it['snippet']) as String, maxLines: 3, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2, h: 1.4))),
        if (it['reason'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(it['classified_by'] == 'ai' ? Icons.auto_awesome_outlined : Icons.rule, size: 14, color: q.text3),
              const SizedBox(width: 6),
              Expanded(child: Text(it['reason'] as String, style: qs(12, c: q.text3))),
            ]),
          ),
        const SizedBox(height: 8),
        Row(children: [
          if (lead)
            TextButton(
              onPressed: () async {
                final ignore = await showModalBottomSheet<bool>(
                  context: context,
                  builder: (_) => SafeArea(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      ListTile(leading: const Icon(Icons.close), title: const Text('Not a lead'), onTap: () => Navigator.pop(context, false)),
                      if (it['from_email'] != null) ListTile(leading: const Icon(Icons.block), title: Text('Not a lead, and ignore @${(it['from_email'] as String).split('@').last}'), onTap: () => Navigator.pop(context, true)),
                    ]),
                  ),
                );
                if (ignore == null || !context.mounted) return;
                final r = await act(context, ref, (api) => api.post('/leads/inbox/${it['id']}/mark', {'lead': false, 'ignoreSender': ignore}), ok: 'Marked as not a lead');
                if (r != null) await onChanged();
              },
              child: const Text('Not a lead'),
            )
          else
            TextButton(
              onPressed: () async {
                final r = await act(context, ref, (api) => api.post('/leads/inbox/${it['id']}/mark', {'lead': true}), ok: 'Added as a lead');
                if (r != null) await onChanged();
              },
              child: const Text('It\'s a lead'),
            ),
          if (lead) ...[
            const Spacer(),
            PopupMenuButton<String>(
              tooltip: 'Change urgency',
              onSelected: (u) async {
                final r = await act(context, ref, (api) => api.post('/leads/inbox/${it['id']}/mark', {'lead': true, 'urgency': u}), ok: 'Updated');
                if (r != null) await onChanged();
              },
              itemBuilder: (_) => [for (final u in ['urgent', 'high', 'normal', 'low']) PopupMenuItem(value: u, child: UrgencyPill(u))],
              child: Padding(padding: const EdgeInsets.all(8), child: Text('Urgency', style: qs(14, w: FontWeight.w600, c: q.text2))),
            ),
          ],
        ]),
      ]),
    );
  }
}

/// What counts as a lead, what is urgent, and who gets told. Editable by hand or drafted by AI from a description.
class LeadRulesScreen extends ConsumerStatefulWidget {
  const LeadRulesScreen({super.key});
  @override
  ConsumerState<LeadRulesScreen> createState() => _LeadRulesState();
}

class _LeadRulesState extends ConsumerState<LeadRulesScreen> {
  Map<String, dynamic>? _r;
  Object? _err;
  bool _dirty = false, _saving = false;
  final _instructions = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _instructions.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = ((await ref.read(apiProvider).get('/leads/rules')) as Map).cast<String, dynamic>();
      _set(r, dirty: false);
    } catch (e) {
      if (mounted) setState(() => _err = e);
    }
  }

  void _set(Map<String, dynamic> r, {bool dirty = true}) {
    if (!mounted) return;
    setState(() {
      _r = r;
      _dirty = dirty;
      _instructions.text = r['instructions'] as String? ?? '';
    });
  }

  void _update(String k, dynamic v) => setState(() {
        _r![k] = v;
        _dirty = true;
      });

  Future<void> _save() async {
    setState(() => _saving = true);
    final body = {..._r!, 'instructions': _instructions.text};
    final r = await act(context, ref, (api) => api.put('/leads/rules', body), ok: 'Rules saved');
    if (!mounted) return;
    setState(() => _saving = false);
    if (r != null) _set((r as Map).cast<String, dynamic>(), dirty: false);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(sessionProvider);
    final r = _r;
    if (r == null) return Page2(title: 'Lead rules', body: _err != null ? ErrorPanel(_err!, onRetry: _load) : const SkeletonList());
    final edit = s.canManage;
    return Page2(
      title: 'Lead rules',
      actions: [if (edit) TextButton(onPressed: _dirty && !_saving ? _save : null, child: const Text('Save'))],
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 40), children: [
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Find leads automatically'), subtitle: const Text('Check new email, form and sheet entries'), value: r['enabled'] == true, onChanged: edit ? (v) => _update('enabled', v) : null),
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Let AI decide unclear messages'), subtitle: const Text('Uses your default AI model. Your keyword rules always win.'), value: r['useAi'] == true, onChanged: edit ? (v) => _update('useAi', v) : null),
        if (edit)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: QButton('Describe your business, let AI draft rules', icon: Icons.auto_awesome_outlined, expand: true, onPressed: () async {
              final desc = await promptText(context, title: 'Describe your leads', label: 'e.g. We do home cleaning in Davao. Leads ask for quotes or bookings. Same-day requests are urgent.', maxLines: 5, action: 'Draft rules');
              if (desc == null || desc.length < 5 || !context.mounted) return;
              final sug = await act(context, ref, (api) => api.post('/leads/rules/suggest', {'description': desc}));
              if (sug != null && context.mounted) {
                _set((sug as Map).cast<String, dynamic>());
                toast(context, 'Draft ready. Review it, then tap Save.');
              }
            }),
          ),
        const SectionLabel('Instructions for the AI'),
        TextField(controller: _instructions, enabled: edit, minLines: 3, maxLines: 8, onChanged: (_) => setState(() => _dirty = true), decoration: const InputDecoration(hintText: 'e.g. Supplier invoices are not leads. Anyone asking about a same-day booking is urgent.')),
        _Chips(title: 'Lead words', help: 'Messages with these words are leads', values: r['leadKeywords'], edit: edit, onChanged: (v) => _update('leadKeywords', v)),
        _Chips(title: 'Urgent words', help: 'Leads with these words are urgent', values: r['urgentKeywords'], edit: edit, onChanged: (v) => _update('urgentKeywords', v)),
        _Chips(title: 'VIP domains', help: 'Always a lead, rated high', values: r['vipDomains'], edit: edit, onChanged: (v) => _update('vipDomains', v), hint: 'bigclient.com'),
        _Chips(title: 'Ignore domains', help: 'Never a lead', values: r['ignoreDomains'], edit: edit, onChanged: (v) => _update('ignoreDomains', v), hint: 'newsletter.com'),
        const SectionLabel('Who gets told'),
        _Choice(label: 'App notifications', value: r['notifyOn'] as String? ?? 'all', enabled: edit, onChanged: (v) => _update('notifyOn', v)),
        _Choice(label: 'Slack alerts', value: r['slackOn'] as String? ?? 'urgent', enabled: edit, onChanged: (v) => _update('slackOn', v)),
        const SectionLabel('Try it'),
        _Tester(saved: !_dirty),
      ]),
    );
  }
}

class _Chips extends StatelessWidget {
  const _Chips({required this.title, required this.help, required this.values, required this.edit, required this.onChanged, this.hint});
  final String title, help;
  final String? hint;
  final dynamic values;
  final bool edit;
  final ValueChanged<List<String>> onChanged;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final list = ((values as List?) ?? const []).map((e) => '$e').toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      SectionLabel(title),
      Text(help, style: qs(13, c: q.text3)),
      const SizedBox(height: 8),
      Wrap(spacing: 6, runSpacing: 6, children: [
        for (final v in list) InputChip(label: Text(v), onDeleted: edit ? () => onChanged([...list]..remove(v)) : null),
        if (edit)
          ActionChip(
            avatar: const Icon(Icons.add, size: 16),
            label: const Text('Add'),
            onPressed: () async {
              final v = await promptText(context, title: 'Add to $title', label: hint ?? 'Word or phrase', action: 'Add');
              final parts = (v ?? '').split(',').map((e) => e.trim().toLowerCase()).where((e) => e.isNotEmpty && !list.contains(e));
              if (parts.isNotEmpty) onChanged([...list, ...parts]);
            },
          ),
      ]),
    ]);
  }
}

class _Choice extends StatelessWidget {
  const _Choice({required this.label, required this.value, required this.enabled, required this.onChanged});
  final String label, value;
  final bool enabled;
  final ValueChanged<String> onChanged;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(children: [
          Expanded(child: Text(label, style: qs(15, c: context.q.text))),
          if (!enabled)
            Text(switch (value) { 'all' => 'All leads', 'urgent' => 'Urgent only', _ => 'Off' }, style: qs(14, w: FontWeight.w600, c: context.q.text2))
          else
          SegmentedButton<String>(
            showSelectedIcon: false,
            segments: const [ButtonSegment(value: 'all', label: Text('All')), ButtonSegment(value: 'urgent', label: Text('Urgent')), ButtonSegment(value: 'none', label: Text('Off'))],
            selected: {value},
            onSelectionChanged: enabled ? (s) => onChanged(s.first) : null,
          ),
        ]),
      );
}

class _Tester extends ConsumerStatefulWidget {
  const _Tester({required this.saved});
  final bool saved;
  @override
  ConsumerState<_Tester> createState() => _TesterState();
}

class _TesterState extends ConsumerState<_Tester> {
  final _from = TextEditingController(), _subject = TextEditingController(), _text = TextEditingController();
  Map<String, dynamic>? _res;
  bool _busy = false;
  @override
  void dispose() {
    _from.dispose();
    _subject.dispose();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final r = _res;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(widget.saved ? 'Paste a sample message to see how Qline would sort it.' : 'Save first: the test uses your saved rules.', style: qs(13, c: widget.saved ? q.text3 : q.warn)),
      const SizedBox(height: 8),
      TextField(controller: _from, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'From (email)')),
      const SizedBox(height: 8),
      TextField(controller: _subject, decoration: const InputDecoration(labelText: 'Subject')),
      const SizedBox(height: 8),
      TextField(controller: _text, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: 'Message')),
      const SizedBox(height: 10),
      QButton('Test', icon: Icons.science_outlined, busy: _busy, expand: true, onPressed: () async {
        setState(() => _busy = true);
        final res = await act(context, ref, (api) => api.post('/leads/rules/test', {'from': _from.text.trim(), 'subject': _subject.text.trim(), 'text': _text.text.trim()}));
        if (mounted) {
          setState(() {
            _busy = false;
            if (res != null) _res = (res as Map).cast<String, dynamic>();
          });
        }
      }),
      if (r != null)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: QCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Text(r['isLead'] == true ? 'Lead' : 'Not a lead', style: qs(16, w: FontWeight.w600, c: q.text)), const Spacer(), if (r['isLead'] == true) UrgencyPill(r['urgency'] as String?)]),
              const SizedBox(height: 6),
              Text(r['reason'] as String? ?? '', style: qs(13, c: q.text2)),
              Text('Decided by ${r['by'] == 'ai' ? 'AI' : 'your rules'} · score ${r['score']}', style: qs(12, c: q.text3)),
            ]),
          ),
        ),
    ]);
  }
}
