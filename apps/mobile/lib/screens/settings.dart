import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/config.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'ai.dart';
import 'integrations.dart';
import 'leads.dart';
import 'voice_settings.dart';
import 'setup.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    final prefs = ref.watch(prefsProvider);
    Widget nav(IconData i, String t, String sub, Widget page) => ListTile(leading: Icon(i), title: Text(t), subtitle: Text(sub), trailing: Icon(Icons.chevron_right, color: q.text3), onTap: () => push(context, page));
    return Page2(
      title: 'Settings',
      body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
        const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: SectionLabel('Account')),
        ListTile(leading: const Icon(Icons.person_outline), title: Text(s.userName ?? ''), subtitle: Text(s.email ?? '')),
        ListTile(
          leading: const Icon(Icons.business_outlined),
          title: Text(s.org?.name ?? ''),
          subtitle: Text('Your role: ${cap(s.role)}'),
          trailing: s.canManage ? const Icon(Icons.edit_outlined) : null,
          onTap: !s.canManage
              ? null
              : () async {
                  final name = await promptText(context, title: 'Rename organisation', label: 'Name', initial: s.org?.name);
                  if (name != null && name.isNotEmpty && context.mounted) {
                    await act(context, ref, (api) => api.patch('/org', {'name': name}), ok: 'Renamed');
                    await ref.read(sessionProvider.notifier).refresh().catchError((_) {});
                  }
                },
        ),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: SectionLabel('Organisation')),
        nav(Icons.memory, 'AI providers', 'Your keys for OpenAI, Claude, Gemini, Grok, DeepSeek', const AiProvidersScreen()),
        nav(Icons.hub_outlined, 'Integrations', 'Gmail, Sheets, Forms, Calendar, Outlook, Slack', const IntegrationsScreen()),
        nav(Icons.rule, 'Lead rules', 'What counts as a lead, what is urgent', const LeadRulesScreen()),
        nav(Icons.group_outlined, 'Team', 'Members, roles and invite codes', const MembersScreen()),
        if (s.role != 'member' && s.role != 'viewer') nav(Icons.fact_check_outlined, 'Audit log', 'Every change, tamper-evident', const AuditScreen()),
        nav(Icons.history, 'Configuration versions', 'Review and roll back setup', const Page2(title: 'Configuration', body: SingleChildScrollView(padding: EdgeInsets.all(16), child: ConfigHistory()))),
        if (s.canManage)
          ListTile(
            leading: const Icon(Icons.download_outlined),
            title: const Text('Export all data'),
            subtitle: const Text('JSON file with your records'),
            onTap: () async {
              try {
                final bytes = await ref.read(apiProvider).download('/exports');
                final uri = await FilePicker.saveFile(fileName: 'qline-export-${DateTime.now().toIso8601String().substring(0, 10)}.json', bytes: Uint8List.fromList(bytes), mimeType: 'application/json');
                if (context.mounted) toast(context, uri == null ? 'Export cancelled' : 'Export saved');
              } catch (e) {
                if (context.mounted) toastError(context, e);
              }
            },
          ),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: SectionLabel('Display')),
        SwitchListTile(secondary: const Icon(Icons.light_mode_outlined), title: const Text('Light theme'), subtitle: const Text('Live AI always stays dark'), value: prefs.light, onChanged: (v) => ref.read(prefsProvider.notifier).set(light: v)),
        SwitchListTile(secondary: const Icon(Icons.motion_photos_off_outlined), title: const Text('Reduce motion'), subtitle: const Text('Still core, no transitions'), value: prefs.reduceMotion, onChanged: (v) => ref.read(prefsProvider.notifier).set(reduceMotion: v)),
        nav(Icons.record_voice_over_outlined, 'Voice', prefs.speak ? 'Spoken replies on · choose a natural voice' : 'Spoken replies off · choose a natural voice', const VoiceSettingsScreen()),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: SectionLabel('About')),
        nav(Icons.health_and_safety_outlined, 'System status', 'Server, storage and AI availability', const StatusScreen()),
        ListTile(leading: const Icon(Icons.info_outline), title: const Text('Version'), subtitle: Text('${AppConfig.version} (${AppConfig.build})', style: qs(13, c: q.text3, family: mono))),
        Padding(
          padding: const EdgeInsets.all(16),
          child: QButton('Sign out', kind: QBtn.destructive, expand: true, onPressed: () async {
            if (await confirm(context, title: 'Sign out?', body: 'You\'ll need your password to sign back in.', action: 'Sign out', destructive: true)) {
              await ref.read(sessionProvider.notifier).signOut();
              if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
            }
          }),
        ),
      ]),
    );
  }
}

class MembersScreen extends ConsumerWidget {
  const MembersScreen({super.key});
  static const roles = ['admin', 'manager', 'member', 'viewer'];
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    return Page2(
      title: 'Team',
      body: Load<Map>(
        fetch: (api) async => await api.get('/members') as Map,
        builder: (context, r, reload) {
          final members = items(r);
          final invites = items(r, 'invitations');
          return ListView(padding: const EdgeInsets.all(16), children: [
            if (s.canManage)
              QButton('Invite someone', icon: Icons.person_add_alt, expand: true, onPressed: () async {
                final role = await showModalBottomSheet<String>(
                  context: context,
                  builder: (ctx) => SafeArea(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('Invite as…', style: qs(16, w: FontWeight.w600, c: ctx.q.text))),
                      for (final role in roles) ListTile(title: Text(cap(role)), subtitle: Text(_roleHelp(role)), onTap: () => Navigator.pop(ctx, role)),
                    ]),
                  ),
                );
                if (role == null || !context.mounted) return;
                final inv = await act(context, ref, (api) => api.post('/invitations', {'role': role}));
                if (inv is Map && context.mounted) {
                  await showDialog(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: const Text('Invite code'),
                      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Share this code with your teammate. It\'s shown only once and expires in 7 days. Qline doesn\'t send emails yet.', style: qs(14, c: ctx.q.text2)),
                        const SizedBox(height: 12),
                        SelectableText(inv['code'] as String, style: qs(18, w: FontWeight.w600, c: ctx.q.text, family: mono)),
                      ]),
                      actions: [
                        QButton('Copy', icon: Icons.copy, onPressed: () {
                          Clipboard.setData(ClipboardData(text: inv['code'] as String));
                          toast(ctx, 'Copied');
                        }),
                        QButton('Done', onPressed: () => Navigator.pop(ctx)),
                      ],
                    ),
                  );
                }
              }),
            SectionLabel('Members (${members.length})'),
            for (final m in members)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: CircleAvatar(backgroundColor: q.surface2, child: Text(((m['name'] as String?) ?? '?').characters.first.toUpperCase(), style: qs(14, c: q.text))),
                title: Text(m['name'] as String? ?? m['email'] as String? ?? ''),
                subtitle: Text('${cap(m['role'] as String)} · ${m['email']}${m['status'] != 'active' ? ' · ${m['status']}' : ''}'),
                trailing: s.canManage && m['role'] != 'owner'
                    ? PopupMenuButton<String>(
                        tooltip: 'Change role',
                        onSelected: (v) async {
                          if (v == 'remove') {
                            if (await confirm(context, title: 'Remove ${m['name']}?', body: 'They lose access to this organisation immediately.', action: 'Remove', destructive: true)) {
                              if (context.mounted) await act(context, ref, (api) => api.delete('/members/${m['id']}'), ok: 'Removed');
                            }
                          } else {
                            await act(context, ref, (api) => api.patch('/members/${m['id']}', {'role': v}), ok: 'Role updated');
                          }
                        },
                        itemBuilder: (_) => [for (final r in roles) PopupMenuItem(value: r, child: Text('Make ${cap(r)}')), const PopupMenuItem(value: 'remove', child: Text('Remove'))],
                      )
                    : null,
              ),
            if (invites.isNotEmpty) ...[
              SectionLabel('Pending invites (${invites.length})'),
              for (final i in invites)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.mail_outline),
                  title: Text(cap(i['role'] as String)),
                  subtitle: Text('Expires ${dateLabel(i['expires_at'] as String?)}'),
                  trailing: s.canManage ? IconButton(tooltip: 'Revoke', icon: const Icon(Icons.close), onPressed: () => act(context, ref, (api) => api.delete('/invitations/${i['id']}'), ok: 'Invite revoked')) : null,
                ),
            ],
          ]);
        },
      ),
    );
  }
}

String _roleHelp(String r) => switch (r) {
      'admin' => 'Everything except ownership',
      'manager' => 'Run workflows, approve medium-risk actions',
      'member' => 'Work with tasks, contacts and AI',
      _ => 'Read only',
    };

class AuditScreen extends ConsumerWidget {
  const AuditScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Page2(
      title: 'Audit log',
      actions: [
        IconButton(
          tooltip: 'Verify integrity',
          icon: const Icon(Icons.verified_outlined),
          onPressed: () async {
            try {
              final r = await ref.read(apiProvider).get('/audit/verify') as Map;
              if (context.mounted) toast(context, r['ok'] == true ? 'Chain intact · ${r['checked']} events checked' : 'Chain broken at event ${r['brokenAt']}');
            } catch (e) {
              if (context.mounted) toastError(context, e);
            }
          },
        ),
      ],
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/audit', {'limit': 100})),
        builder: (context, list, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: list.length,
            separatorBuilder: (_, _) => const Divider(),
            itemBuilder: (_, i) {
              final e = list[i];
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(e['action'] as String, style: qs(13, w: FontWeight.w600, c: q.text, family: mono))),
                    Text(ago(e['at'] as String?), style: qs(12, c: q.text3)),
                  ]),
                  const SizedBox(height: 2),
                  Text('${cap(e['actor_kind'] as String)} · ${e['target_ref'] ?? ''}', style: qs(12, c: q.text3)),
                  if (e['detail'] is Map && (e['detail'] as Map).isNotEmpty) Text(jsonEncode(e['detail']), maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(11, c: q.text3, family: mono)),
                ]),
              );
            },
          ),
        ),
      ),
    );
  }
}

class StatusScreen extends StatelessWidget {
  const StatusScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'System status',
      body: Load<List<dynamic>>(
        fetch: (api) async => [await api.get('/health/ready').catchError((e) => {'status': 'degraded'}), await api.get('/ai/overview').catchError((e) => {'status': 'unavailable'})],
        builder: (context, r, reload) {
          final h = r[0] as Map;
          final ai = r[1] as Map;
          final checks = (h['checks'] as Map?) ?? {};
          Widget row(String label, bool ok, String detail) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(ok ? Icons.check_circle_outline : Icons.error_outline, color: ok ? q.ok : q.warn),
                title: Text(label),
                subtitle: Text(detail),
              );
          return ListView(padding: const EdgeInsets.all(16), children: [
            row('Server', h['status'] == 'ok', h['status'] == 'ok' ? 'Reachable' : 'Degraded'),
            row('Database', checks['database'] == true, checks['database'] == true ? 'Connected' : 'Not reachable'),
            row('File storage', checks['storage'] == true, checks['storage'] == true ? 'Connected' : 'Not available'),
            row('AI', ai['status'] == 'ready', switch (ai['status']) {
              'ready' => 'Default: ${modelLabel(ai['default'] as Map?, items(ai, 'providers'))}',
              'no_default' => 'Provider connected, no default model chosen',
              'not_configured' => 'No AI provider connected (Settings → AI providers)',
              _ => 'Could not check',
            }),
            const SizedBox(height: 8),
            Text('Server: ${AppConfig.apiBase}', style: qs(11, c: q.text3, family: mono)),
            const SizedBox(height: 12),
            QButton('Check again', icon: Icons.refresh, onPressed: reload),
          ]);
        },
      ),
    );
  }
}
