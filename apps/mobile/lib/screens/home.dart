import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'approvals.dart';
import 'business.dart';
import 'work.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key, required this.onTab});
  final ValueChanged<int> onTab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final name = ref.watch(sessionProvider.select((s) => s.userName)) ?? '';
    return Load<Map>(
      fetch: (api) async => await api.get('/dashboard') as Map,
      builder: (context, d, reload) {
        final widgets = items(d, 'widgets');
        final focus = items(d, 'focus');
        final approvals = items(d, 'approvals');
        final activity = items(d, 'activity');
        final hour = DateTime.now().hour;
        final greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        return RefreshIndicator(
          color: q.halo,
          onRefresh: reload,
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
            Text('$greet${name.isEmpty ? '' : ', ${name.split(' ').first}'}', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 4),
            Text(d['businessName'] != null ? 'Here\'s ${d['businessName']} right now.' : 'Here\'s your business right now.', style: qs(14, c: q.text2)),
            if (d['configured'] != true) ...[
              const SizedBox(height: 16),
              QCard(
                accent: q.halo.withValues(alpha: .5),
                onTap: () => push(context, const SetupScreen()),
                child: Row(children: [
                  Icon(Icons.auto_awesome_outlined, color: q.halo),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Set up your business', style: qs(15, w: FontWeight.w600, c: q.text)),
                      const SizedBox(height: 2),
                      Text('Answer 12 short questions. You review every change before it\'s applied.', style: qs(13, c: q.text2)),
                    ]),
                  ),
                  Icon(Icons.chevron_right, color: q.text3),
                ]),
              ),
            ],
            if (approvals.isNotEmpty) ...[
              SectionLabel('Waiting for you', trailing: TextButton(onPressed: () => push(context, const ApprovalsScreen()), child: Text('See all', style: qs(13, w: FontWeight.w600, c: q.text2)))),
              for (final a in approvals)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: QCard(
                    accent: q.halo.withValues(alpha: .4),
                    onTap: () => push(context, ApprovalDetail(id: a['id'] as String)),
                    child: Row(children: [
                      Icon(Icons.verified_user_outlined, color: q.halo, size: 20),
                      const SizedBox(width: 12),
                      Expanded(child: Text(approvalTitle(a), style: qs(14, w: FontWeight.w600, c: q.text))),
                      RiskTag(a['risk'] as String?),
                    ]),
                  ),
                ),
            ],
            const SectionLabel('At a glance'),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 1.55,
              children: [
                for (final w in widgets.take(6))
                  QCard(
                    padding: const EdgeInsets.all(14),
                    onTap: () => switch (w['key']) {
                      'pending_approvals' => push(context, const ApprovalsScreen()),
                      'open_tasks' || 'overdue_tasks' || 'due_week' || 'done_week' => onTab(1),
                      'contacts' => push(context, const ContactsScreen()),
                      _ => null,
                    },
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(w['label'] as String, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2)),
                      const Spacer(),
                      Text('${w['value']}', style: qs(28, w: FontWeight.w600, c: w['key'] == 'overdue_tasks' && (w['value'] as num) > 0 ? q.bad : q.text, family: mono)),
                      Text('${w['source']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(10, c: q.text3, family: mono)),
                    ]),
                  ),
              ],
            ),
            Padding(padding: const EdgeInsets.only(top: 6, left: 4), child: Text('Counts computed live from your workspace · ${ago(d['asOf'] as String?)}', style: qs(11, c: q.text3))),
            SectionLabel('Focus', trailing: TextButton(onPressed: () => onTab(1), child: Text('All work', style: qs(13, w: FontWeight.w600, c: q.text2)))),
            if (focus.isEmpty)
              QCard(child: Text('No open tasks. Add one from Work or ask the AI.', style: qs(14, c: q.text2)))
            else
              QCard(
                padding: EdgeInsets.zero,
                child: Column(children: [
                  for (final (i, t) in focus.indexed) ...[
                    if (i > 0) const Divider(),
                    TaskRow(task: t),
                  ],
                ]),
              ),
            const SectionLabel('Recent activity'),
            if (activity.isEmpty)
              Text('Nothing yet.', style: qs(14, c: q.text3))
            else
              for (final e in activity)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
                  child: Row(children: [
                    Icon(e['actor_kind'] == 'agent' ? Icons.smart_toy_outlined : e['actor_kind'] == 'system' ? Icons.settings_outlined : Icons.person_outline, size: 16, color: q.text3),
                    const SizedBox(width: 10),
                    Expanded(child: Text(cap((e['action'] as String).replaceAll('.', ' ')), style: qs(13, c: q.text2))),
                    Text(ago(e['at'] as String?), style: qs(12, c: q.text3, family: mono)),
                  ]),
                ),
          ]),
        );
      },
    );
  }
}
