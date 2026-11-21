import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'agent_studio.dart';
import 'ai.dart';
import 'import.dart';
import 'integrations.dart';
import 'domains.dart';
import 'leads.dart';
import 'proposals.dart';
import 'settings.dart';
import 'setup.dart';
import 'workflows.dart';

export 'setup.dart' show SetupScreen;

class BusinessScreen extends ConsumerWidget {
  const BusinessScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    Widget tile(IconData icon, String title, String sub, Widget page) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: QCard(
            onTap: () => push(context, page),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(children: [
              Icon(icon, color: q.text2),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: qs(15, w: FontWeight.w600, c: q.text)), const SizedBox(height: 2), Text(sub, style: qs(13, c: q.text3))])),
              Icon(Icons.chevron_right, color: q.text3),
            ]),
          ),
        );
    // Phase 7 (ADR-1): a personal space shows the same tools with personal wording, and no business-only items.
    final personal = ref.watch(sessionProvider.select((s) => s.personal));
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
      const SectionLabel('Your AI team'),
      const _AgentStrip(),
      const SizedBox(height: 8),
      const ProposalsSection(kind: 'agent_change'),
      SectionLabel(personal ? 'Your life and work' : 'Run the business'),
      tile(Icons.label_outline, 'Domains', personal ? 'Personal, Work, Learning and your own areas' : 'Areas your work is grouped into', const DomainsScreen()),
      tile(Icons.people_outline, personal ? 'People' : 'Clients & contacts', personal ? 'People you keep in touch with' : 'People and companies you work with', const ContactsScreen()),
      tile(Icons.account_tree_outlined, 'Workflows', 'Automations with approval steps', const WorkflowsScreen()),
      tile(Icons.upload_file_outlined, 'Import data', 'Spreadsheets and documents into Qline', const ImportScreen()),
      tile(Icons.hub_outlined, 'Integrations', 'Gmail, Drive, Calendar, Notion, GitHub and more', const IntegrationsScreen()),
      if (!personal) tile(Icons.inbox_outlined, 'Lead inbox', 'New enquiries from email and forms, rated by urgency', const LeadInboxScreen()),
      const SectionLabel('Configure'),
      if (!personal) tile(Icons.auto_awesome_outlined, 'Business setup', 'Guided interview and configuration history', const SetupScreen()),
      tile(Icons.settings_outlined, 'Settings', personal ? 'Account, privacy, export' : 'Account, team, audit log, export', const SettingsScreen()),
    ]);
  }
}

class _AgentStrip extends ConsumerWidget {
  const _AgentStrip();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canManage = ref.watch(sessionProvider.select((s) => s.canManage));
    return Load<List<Map<String, dynamic>>>(
      skeleton: const SizedBox(height: 120),
      fetch: (api) async => items(await api.get('/agents')),
      builder: (context, list, reload) => SizedBox(
        // UX audit 2026-11-21: fixed 128 clipped agent names at large text.
        height: 128 * MediaQuery.textScalerOf(context).scale(1).clamp(1.0, 1.8),
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: list.length + (canManage ? 1 : 0),
          separatorBuilder: (_, _) => const SizedBox(width: 8),
          itemBuilder: (_, i) {
            if (i == list.length) {
              // Phase 4 / M9: make your own agent.
              return SizedBox(
                width: 132,
                child: QCard(
                  padding: const EdgeInsets.all(12),
                  onTap: () async {
                    final id = await showAgentEditor(context);
                    if (id != null && context.mounted) push(context, AgentDetail(id: id));
                  },
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(Icons.add_circle_outline, size: 36, color: q.halo),
                    const Spacer(),
                    Text('New agent', style: qs(14, w: FontWeight.w600, c: q.text)),
                    Text('Make your own', maxLines: 1, style: qs(12, c: q.text3)),
                  ]),
                ),
              );
            }
            final a = list[i];
            final paused = a['status'] != 'active';
            return SizedBox(
              width: 132,
              child: QCard(
                padding: const EdgeInsets.all(12),
                onTap: () => push(context, AgentDetail(id: a['id'] as String)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  AgentOrb(a['template'] as String?, paused: paused, accent: a['accent'] as String?),
                  const Spacer(),
                  Text(a['name'] as String, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(14, w: FontWeight.w600, c: q.text)),
                  Text(paused ? 'Paused' : '${a['runs_week']} runs this week', maxLines: 1, style: qs(12, c: q.text3)),
                ]),
              ),
            );
          },
        ),
      ),
    );
  }
}

class AgentDetail extends ConsumerWidget {
  const AgentDetail({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canManage = ref.watch(sessionProvider.select((s) => s.canManage));
    return Page2(
      title: 'Agent',
      body: Load<List<dynamic>>(
        fetch: (api) async => [await api.get('/agents/$id'), items(await api.get('/agents'))],
        builder: (context, data, reload) {
          final a = data[0] as Map;
          final summary = (data[1] as List<Map<String, dynamic>>).where((x) => x['id'] == id).firstOrNull ?? {};
          final tools = items(summary, 'tools');
          final runs = items(a, 'runs');
          final active = a['status'] == 'active';
          final style = AgentStyle.ofAgent(a);
          final custom = a['template'] == 'custom';
          return ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [
              AgentOrb(a['template'] as String?, size: 52, paused: !active, accent: a['accent'] as String?),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(a['name'] as String, style: Theme.of(context).textTheme.headlineSmall),
                  Text(style.role, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text2)),
                ]),
              ),
              StatusPill(a['status'] as String),
            ]),
            const SizedBox(height: 16),
            if (canManage) ...[
              Row(children: [
                Expanded(
                  child: QButton(active ? 'Pause agent' : 'Activate agent', icon: active ? Icons.pause : Icons.play_arrow, onPressed: () => act(context, ref, (api) => api.patch('/agents/$id', {'status': active ? 'paused' : 'active'}), ok: active ? 'Paused' : 'Active').then((_) => reload())),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: QButton('Edit', icon: Icons.edit_note, onPressed: () async {
                    if (await showAgentEditor(context, agent: a) != null) reload();
                  }),
                ),
              ]),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                QButton('Preview', kind: QBtn.ghost, icon: Icons.chat_bubble_outline, onPressed: () => showAgentPreview(context, a)),
                QButton('Versions', kind: QBtn.ghost, icon: Icons.history, onPressed: () async {
                  await push(context, AgentVersionsScreen(agentId: id, canManage: canManage));
                  reload();
                }),
                QButton('Duplicate', kind: QBtn.ghost, icon: Icons.copy_outlined, onPressed: () async {
                  final nid = await showAgentEditor(context, cloneFrom: a);
                  if (nid != null && context.mounted) Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => AgentDetail(id: nid)));
                }),
                if (custom)
                  QButton('Archive', kind: QBtn.ghost, icon: Icons.archive_outlined, onPressed: () async {
                    if (!await confirm(context, title: 'Archive ${a['name']}?', body: 'It stops answering and leaves your agent list. Past chats with it stay readable.', action: 'Archive', destructive: true)) return;
                    if (!context.mounted) return;
                    final r = await act(context, ref, (api) => api.delete('/agents/$id'), ok: 'Archived');
                    if (r != null && context.mounted) Navigator.pop(context);
                  }),
              ]),
            ],
            if (a['approval_mode'] == 'ask_all' || (a['max_tool_calls'] as num? ?? 8) < 8 || a['daily_runs'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  [
                    if (a['approval_mode'] == 'ask_all') 'Asks before every change',
                    if ((a['max_tool_calls'] as num? ?? 8) < 8) 'Up to ${a['max_tool_calls']} steps per answer',
                    if (a['daily_runs'] != null) '${a['daily_runs']} answers a day',
                  ].join(' · '),
                  style: qs(12, c: q.text2),
                ),
              ),
            const SectionLabel('Instructions'),
            QCard(child: Text(a['instructions'] as String? ?? '', style: qs(14, c: q.text2, h: 1.5))),
            Padding(padding: const EdgeInsets.only(top: 6, left: 4), child: Text('Version ${a['current_version']}', style: qs(11, c: q.text3, family: mono))),
            const SectionLabel('AI model'),
            AgentModelCard(agentId: id, canManage: canManage),
            const SectionLabel('What it can do'),
            QCard(
              padding: EdgeInsets.zero,
              child: Column(children: [
                for (final (i, t) in tools.indexed) ...[
                  if (i > 0) const Divider(),
                  ListTile(
                    dense: true,
                    title: Text(t['name'] as String, style: qs(13, c: q.text, family: mono)),
                    subtitle: Text(t['implemented'] == true ? 'Built in' : 'Planned — not available yet', style: qs(12, c: q.text3)),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(t['decision'] == 'allow' ? Icons.bolt : t['decision'] == 'deny' ? Icons.block : Icons.verified_user_outlined, size: 15, color: t['decision'] == 'allow' ? q.text2 : t['decision'] == 'deny' ? q.bad : q.halo),
                      const SizedBox(width: 4),
                      Text(t['decision'] == 'allow' ? 'Runs on its own' : t['decision'] == 'deny' ? 'Blocked' : 'Asks first', style: qs(12, c: q.text2)),
                    ]),
                  ),
                ],
              ]),
            ),
            SectionLabel('Recent runs (${runs.length})'),
            if (runs.isEmpty) Text('No runs yet.', style: qs(14, c: q.text3)),
            for (final r in runs)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  StatusPill(r['status'] as String),
                  const SizedBox(width: 10),
                  Expanded(child: Text(r['error'] as String? ?? cap(r['trigger'] as String? ?? ''), maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2))),
                  Text(ago(r['created_at'] as String?), style: qs(12, c: q.text3, family: mono)),
                ]),
              ),
          ]);
        },
      ),
    );
  }
}

class ContactsScreen extends ConsumerStatefulWidget {
  const ContactsScreen({super.key});
  @override
  ConsumerState<ContactsScreen> createState() => _ContactsState();
}

class _ContactsState extends ConsumerState<ContactsScreen> {
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final canWrite = ref.watch(sessionProvider.select((s) => s.canWrite));
    return Page2(
      title: 'Clients & contacts',
      fab: canWrite ? FloatingActionButton(heroTag: null, tooltip: 'Add contact', onPressed: () => showContactEditor(context, ref), child: const Icon(Icons.person_add_alt)) : null,
      body: Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 8), child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search name or email', isDense: true), onSubmitted: (v) => setState(() => _q = v.trim()))),
        Expanded(
          child: Load<List<Map<String, dynamic>>>(
            key: ValueKey(_q),
            fetch: (api) async => items(await api.get('/contacts', {'q': _q, 'limit': 100})),
            builder: (context, list, reload) => list.isEmpty
                ? EmptyState(icon: Icons.people_outline, title: _q.isEmpty ? 'No contacts yet' : 'No matches', body: _q.isEmpty ? 'Add people by hand or import a spreadsheet from Business → Import.' : null)
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 96),
                    itemCount: list.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 6),
                    itemBuilder: (_, i) {
                      final c = list[i];
                      return QCard(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        onTap: () => showContactEditor(context, ref, contact: c),
                        child: Row(children: [
                          CircleAvatar(radius: 18, backgroundColor: q.surface2, child: Text((c['name'] as String).characters.first.toUpperCase(), style: qs(14, w: FontWeight.w600, c: q.text))),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(c['name'] as String, style: qs(15, w: FontWeight.w600, c: q.text)),
                              Text([c['title'], c['company_name'], c['email']].whereType<String>().where((s) => s.isNotEmpty).join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text3)),
                            ]),
                          ),
                          if (c['stage'] != null) StatusPill(c['stage'] as String),
                          if (c['source_kind'] == 'import') const Padding(padding: EdgeInsets.only(left: 8), child: SourceTag('import')),
                        ]),
                      );
                    },
                  ),
          ),
        ),
      ]),
    );
  }
}

Future<void> showContactEditor(BuildContext context, WidgetRef ref, {Map? contact}) async {
  final f = {for (final k in ['name', 'email', 'phone', 'title', 'stage', 'notes']) k: TextEditingController(text: contact?[k] as String?)};
  String? error;
  final canWrite = ref.read(sessionProvider).canWrite;
  await showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
      final q = ctx.q;
      Widget field(String k, String label, {TextInputType? type, int lines = 1}) => Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: TextField(controller: f[k], readOnly: !canWrite, keyboardType: type, minLines: 1, maxLines: lines, decoration: InputDecoration(labelText: label, errorText: k == 'name' ? error : null)),
          );
      return Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(ctx).viewInsets.bottom + 20),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(contact == null ? 'New contact' : 'Contact', style: qs(18, w: FontWeight.w600, c: q.text)),
            if (contact != null) Padding(padding: const EdgeInsets.only(top: 4), child: SourceTag(contact['source_kind'] as String?, asOf: contact['created_at'] as String?)),
            const SizedBox(height: 14),
            field('name', 'Name'),
            field('email', 'Email', type: TextInputType.emailAddress),
            field('phone', 'Phone', type: TextInputType.phone),
            field('title', 'Role or title'),
            field('stage', 'Stage (e.g. lead, client)'),
            field('notes', 'Notes', lines: 4),
            if (canWrite) ...[
              const SizedBox(height: 6),
              QButton('Save', expand: true, onPressed: () async {
                if (f['name']!.text.trim().isEmpty) return set(() => error = 'Name is required');
                final body = {for (final e in f.entries) e.key: e.value.text.trim().isEmpty ? null : e.value.text.trim()};
                final r = await act(ctx, ref, (api) => contact == null ? api.post('/contacts', body) : api.patch('/contacts/${contact['id']}', body));
                if (r != null && ctx.mounted) Navigator.pop(ctx);
              }),
              if (contact != null) ...[
                const SizedBox(height: 8),
                QButton('Delete contact', kind: QBtn.destructive, expand: true, onPressed: () async {
                  if (await confirm(ctx, title: 'Delete contact?', body: 'This removes ${contact['name']} from your contacts.', action: 'Delete', destructive: true)) {
                    if (!ctx.mounted) return;
                    final r = await act(ctx, ref, (api) => api.delete('/contacts/${contact['id']}'), ok: 'Contact deleted');
                    if (r != null && ctx.mounted) Navigator.pop(ctx);
                  }
                }),
              ],
            ],
          ]),
        ),
      );
    }),
  );
}

