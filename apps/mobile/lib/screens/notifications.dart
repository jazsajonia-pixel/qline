import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/alerts.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'content.dart' show pageForRef;

IconData alertIcon(String? category) => switch (category) {
      'email_important' => Icons.mark_email_unread_outlined,
      'lead' || 'lead_urgent' => Icons.person_add_alt_outlined,
      'approval' => Icons.verified_user_outlined,
      'workflow' => Icons.account_tree_outlined,
      'assistant' => Icons.auto_awesome_outlined,
      'integration' => Icons.link,
      'content' => Icons.movie_outlined,
      _ => Icons.notifications_none,
    };

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Page2(
      title: 'Notifications',
      body: Load<Map>(
        fetch: (api) async => (await api.get('/notifications')) as Map,
        builder: (context, r, reload) {
          final list = items(r);
          if (list.isEmpty) {
            return const EmptyState(
              icon: Icons.notifications_none,
              title: 'All quiet',
              body: 'Important email, new leads, approvals and reminders from your assistant show up here and on your phone.',
            );
          }
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (_, i) {
                final n = list[i];
                final unread = n['read_at'] == null;
                final page = pageForRef(n['ref']);
                return QCard(
                  accent: unread ? q.halo : null,
                  onTap: unread || page != null
                      ? () async {
                          if (unread) {
                            await act(context, ref, (api) => api.post('/notifications/${n['id']}/read'));
                            final left = list.where((x) => x['read_at'] == null).length - 1;
                            ref.read(unreadAlerts.notifier).set(left < 0 ? 0 : left);
                          }
                          if (page != null && context.mounted) await push(context, page);
                          await reload();
                        }
                      : null,
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(alertIcon(n['category'] as String?), size: 20, color: unread ? q.halo : q.text3),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${n['title'] ?? ''}', style: qs(15, w: unread ? FontWeight.w600 : FontWeight.w500, c: q.text)),
                        if ((n['body'] ?? '').toString().isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text('${n['body']}', style: qs(13, c: q.text2), maxLines: 4, overflow: TextOverflow.ellipsis),
                        ],
                        const SizedBox(height: 6),
                        Text(page != null ? '${ago(n['created_at'] as String?)} · tap to open' : unread ? '${ago(n['created_at'] as String?)} · tap to mark read' : ago(n['created_at'] as String?), style: qs(12, c: q.text3)),
                      ]),
                    ),
                  ]),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
