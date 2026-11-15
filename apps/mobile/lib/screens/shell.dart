import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/core_painter.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'approvals.dart';
import 'business.dart';
import 'home.dart';
import 'library.dart';
import 'live.dart';
import 'work.dart';

/// Pending approvals count, refreshed with refreshTick.
final pendingCount = FutureProvider<int>((ref) async {
  ref.watch(refreshTick);
  ref.watch(sessionProvider.select((s) => s.orgId));
  final r = await ref.read(apiProvider).get('/approvals', {'status': 'pending'});
  return items(r).length;
});

class Shell extends ConsumerStatefulWidget {
  const Shell({super.key});
  @override
  ConsumerState<Shell> createState() => _ShellState();
}

class _ShellState extends ConsumerState<Shell> {
  int _tab = 0;
  static const _titles = ['Home', 'Work', '', 'Business', 'Library'];

  void _openLive() => Navigator.of(context).push(PageRouteBuilder(
        transitionDuration: const Duration(milliseconds: 260),
        pageBuilder: (_, a, _) => FadeTransition(opacity: a, child: const LiveScreen()),
      ));

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    final pending = ref.watch(pendingCount).value ?? 0;
    final pages = [HomeScreen(onTab: (i) => setState(() => _tab = i)), const WorkScreen(), const SizedBox(), const BusinessScreen(), const LibraryScreen()];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: _OrgSwitcher(title: _titles[_tab], session: s),
        actions: [
          IconButton(
            tooltip: pending > 0 ? '$pending approvals waiting' : 'Approvals',
            onPressed: () => push(context, const ApprovalsScreen()),
            icon: Badge(isLabelVisible: pending > 0, label: Text('$pending'), backgroundColor: q.halo, textColor: q.onHalo, child: const Icon(Icons.verified_user_outlined)),
          ),
          IconButton(tooltip: 'Search', onPressed: () => push(context, const SearchScreen()), icon: const Icon(Icons.search)),
          const SizedBox(width: 4),
        ],
      ),
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: _BottomNav(index: _tab, onTap: (i) => i == 2 ? _openLive() : setState(() => _tab = i)),
    );
  }
}

class _OrgSwitcher extends ConsumerWidget {
  const _OrgSwitcher({required this.title, required this.session});
  final String title;
  final SessionState session;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => showModalBottomSheet(
        context: context,
        builder: (ctx) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('Switch organisation', style: qs(16, w: FontWeight.w600, c: q.text))),
            for (final o in session.orgs)
              ListTile(
                leading: Icon(o.id == session.orgId ? Icons.radio_button_checked : Icons.radio_button_off, color: o.id == session.orgId ? q.halo : q.text3),
                title: Text(o.name),
                subtitle: Text(cap(o.role)),
                onTap: () {
                  ref.read(sessionProvider.notifier).switchOrg(o.id);
                  Navigator.pop(ctx);
                },
              ),
            ListTile(
              leading: const Icon(Icons.add),
              title: const Text('Create or join another'),
              onTap: () async {
                Navigator.pop(ctx);
                final name = await promptText(context, title: 'New organisation', label: 'Business name', action: 'Create');
                if (name != null && name.isNotEmpty && context.mounted) {
                  try {
                    await ref.read(sessionProvider.notifier).createOrg(name);
                  } catch (e) {
                    if (context.mounted) toastError(context, e);
                  }
                }
              },
            ),
          ]),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const QMark(size: 22),
          const SizedBox(width: 10),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(session.org?.name ?? 'Qline', overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
              if (title.isNotEmpty) Text(title, style: qs(12, c: q.text3)),
            ]),
          ),
          Icon(Icons.expand_more, size: 18, color: q.text3),
        ]),
      ),
    );
  }
}

class _BottomNav extends ConsumerWidget {
  const _BottomNav({required this.index, required this.onTap});
  final int index;
  final ValueChanged<int> onTap;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final reduce = ref.watch(prefsProvider).reduceMotion;
    Widget item(int i, IconData icon, IconData active, String label) {
      final sel = index == i;
      return Expanded(
        child: Semantics(
          selected: sel,
          button: true,
          label: label,
          child: InkWell(
            onTap: () => onTap(i),
            child: SizedBox(
              height: 64,
              child: ExcludeSemantics(
                child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(sel ? active : icon, color: sel ? q.text : q.text3, size: 22),
                  const SizedBox(height: 4),
                  Text(label, style: qs(11, w: sel ? FontWeight.w600 : FontWeight.w500, c: sel ? q.text : q.text3)),
                ]),
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(color: q.surface1, border: Border(top: BorderSide(color: q.line))),
      child: SafeArea(
        top: false,
        child: Row(children: [
          item(0, Icons.space_dashboard_outlined, Icons.space_dashboard, 'Home'),
          item(1, Icons.check_circle_outline, Icons.check_circle, 'Work'),
          Expanded(
            child: Semantics(
              button: true,
              label: 'Open Live AI',
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: () => onTap(2),
                child: SizedBox(
                  height: 64,
                  child: Center(
                    child: Container(
                      width: 56,
                      height: 56,
                      decoration: BoxDecoration(shape: BoxShape.circle, color: const Color(0xFF05070A), border: Border.all(color: q.line)),
                      clipBehavior: Clip.antiAlias,
                      child: ExcludeSemantics(child: EnergyCore(state: CoreState.idle, reduceMotion: reduce, compact: true, background: false)),
                    ),
                  ),
                ),
              ),
            ),
          ),
          item(3, Icons.business_center_outlined, Icons.business_center, 'Business'),
          item(4, Icons.folder_outlined, Icons.folder, 'Library'),
        ]),
      ),
    );
  }
}
