import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/alerts.dart';
import '../core/back_exit.dart';
import '../core/live_status.dart';
import '../core/session.dart';
import '../core/updater.dart';
import '../ui/core_painter.dart';
import '../ui/theme.dart';
import '../ui/update_banner.dart';
import '../ui/widgets.dart';
import 'approvals.dart';
import 'business.dart';
import 'content.dart' show pageForRef;
import 'home.dart';
import 'library.dart';
import 'live.dart';
import 'notifications.dart';
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

class _ShellState extends ConsumerState<Shell> with SingleTickerProviderStateMixin {
  int _tab = 0;
  static const _titles = ['Home', 'Work', '', 'Business', 'Library'];

  // Background continuity: Live AI stays mounted as a layer over the shell once opened. Minimizing hides
  // it (state, the answer stream and the voice keep going) and the core flies down into the navbar orb.
  final _orbKey = GlobalKey();
  final _coreKey = GlobalKey();
  // Emphasized motion (Animation and Motion skill): ~450 ms in, ~220 ms out.
  late final AnimationController _fly = AnimationController(vsync: this, duration: const Duration(milliseconds: 450), reverseDuration: const Duration(milliseconds: 220));

  void _openLive() => ref.read(liveHostProvider.notifier).open();

  @override
  void dispose() {
    _fly.dispose();
    super.dispose();
  }

  void _onHost(LiveHost? before, LiveHost now) {
    final reduce = ref.read(prefsProvider).reduceMotion || MediaQuery.of(context).disableAnimations;
    switch (now.view) {
      case LiveView.open:
        reduce ? _fly.value = 1 : _fly.forward();
      case LiveView.minimized:
        reduce ? _fly.value = 0 : _fly.reverse();
      case LiveView.closed:
        _fly.value = 0;
    }
  }

  Rect? _rectOf(GlobalKey k) {
    final box = k.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.hasSize || !box.attached) return null;
    return box.localToGlobal(Offset.zero) & box.size;
  }

  /// Where the live core sits; before Live AI has laid out once, roughly where it will appear.
  Rect _coreRect(Size screen, EdgeInsets pad) {
    final r = _rectOf(_coreKey);
    if (r != null && r.width > 0) {
      final side = r.shortestSide * .62;
      return Rect.fromCenter(center: r.center, width: side, height: side);
    }
    final side = screen.width * .42;
    return Rect.fromCenter(center: Offset(screen.width / 2, pad.top + kToolbarHeight + screen.height * .16), width: side, height: side);
  }

  Widget _liveLayer(LiveHost host) {
    final size = MediaQuery.of(context).size;
    final pad = MediaQuery.of(context).padding;
    return AnimatedBuilder(
      animation: _fly,
      builder: (context, child) {
        final t = _fly.value;
        final flying = _fly.isAnimating;
        final status = ref.read(liveStatusProvider);
        final from = _rectOf(_orbKey);
        final curve = _fly.status == AnimationStatus.reverse ? Curves.easeInCubic : Curves.easeOutCubic;
        final p = curve.transform(t);
        return Stack(children: [
          Offstage(
            offstage: t == 0,
            child: TickerMode(
              enabled: t > 0,
              child: IgnorePointer(
                ignoring: flying || host.view != LiveView.open,
                child: Opacity(
                  opacity: const Interval(.35, 1).transform(t),
                  child: Transform.scale(scale: .97 + .03 * p, child: child),
                ),
              ),
            ),
          ),
          if (flying && from != null)
            Positioned.fromRect(
              rect: Rect.lerp(from, _coreRect(size, pad), p)!,
              child: IgnorePointer(
                child: Opacity(
                  // Hands over to the real core as the screen fades in (and back to the orb on the way down).
                  opacity: _fly.status == AnimationStatus.reverse ? 1 : (1 - const Interval(.8, 1).transform(t)),
                  child: ClipOval(
                    child: EnergyCore(state: navCoreState(status.core), agent: status.template ?? 'ceo', compact: true, background: false),
                  ),
                ),
              ),
            ),
        ]);
      },
      child: KeyedSubtree(key: ValueKey(host.session), child: LiveScreen(embedded: true, coreKey: _coreKey)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    final pending = ref.watch(pendingCount).value ?? 0;
    final unread = ref.watch(unreadAlerts);
    final pages = [HomeScreen(onTab: (i) => setState(() => _tab = i)), const WorkScreen(), const SizedBox(), const BusinessScreen(), const LibraryScreen()];
    final host = ref.watch(liveHostProvider);
    ref.listen(liveHostProvider, _onHost);
    // In-app updates: say so once after Qline has updated itself.
    ref.listen(updaterProvider.select((u) => u.justUpdated), (a, b) {
      if (b != null && a != b) {
        toast(context, 'Qline updated to $b');
        ref.read(updaterProvider.notifier).clearJustUpdated();
      }
    });
    // Live AI belongs to one organisation: switching ends it (the answer still finishes on the server).
    ref.listen(sessionProvider.select((s) => s.orgId), (a, b) {
      if (a != b && ref.read(liveHostProvider).mounted) ref.read(liveHostProvider.notifier).end();
    });
    // Run 3 / M5: Back on another tab goes Home first; Back on Home asks before closing the app.
    // Background continuity: Back in Live AI minimizes it.
    final shell = PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (ref.read(liveHostProvider).view == LiveView.open) {
          ref.read(liveHostProvider.notifier).minimize();
          return;
        }
        if (_tab != 0) {
          setState(() => _tab = 0);
          return;
        }
        confirmExit(context);
      },
      child: UpdateWatcher(
      child: AlertWatcher(
      onOpen: (payload) {
        final page = pageForRef(payload);
        if (page != null && mounted) push(context, page);
      },
      child: Scaffold(
        appBar: AppBar(
          titleSpacing: 12,
          title: _OrgSwitcher(title: _tab == 3 && s.personal ? 'Personal' : _titles[_tab], session: s),
          actions: [
            IconButton(
              tooltip: pending > 0 ? '$pending approvals waiting' : 'Approvals',
              onPressed: () => push(context, const ApprovalsScreen()),
              icon: Badge(isLabelVisible: pending > 0, label: Text('$pending'), backgroundColor: q.halo, textColor: q.onHalo, child: const Icon(Icons.verified_user_outlined)),
            ),
            IconButton(
              tooltip: unread > 0 ? '$unread unread notifications' : 'Notifications',
              onPressed: () => push(context, const NotificationsScreen()),
              icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), backgroundColor: q.halo, textColor: q.onHalo, child: const Icon(Icons.notifications_none)),
            ),
            IconButton(tooltip: 'Search', onPressed: () => push(context, const SearchScreen()), icon: const Icon(Icons.search)),
            const SizedBox(width: 4),
          ],
        ),
        body: Column(children: [const UpdateBanner(), Expanded(child: IndexedStack(index: _tab, children: pages))]),
        bottomNavigationBar: _BottomNav(index: _tab, orbKey: _orbKey, fly: _fly, onTap: (i) => i == 2 ? _openLive() : setState(() => _tab = i)),
      ),
      ),
      ),
    );
    return Stack(children: [shell, if (host.mounted) Positioned.fill(child: _liveLayer(host))]);
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
          child: ListView(
            shrinkWrap: true,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: Text(
                  'Switch organisation',
                  style: qs(16, w: FontWeight.w600, c: q.text),
                ),
              ),
              for (final o in session.orgs)
                ListTile(
                  leading: Icon(o.id == session.orgId ? Icons.radio_button_checked : Icons.radio_button_off, color: o.id == session.orgId ? q.halo : q.text3),
                  title: Text(o.name),
                  subtitle: Text(o.personal ? 'Personal space' : cap(o.role)),
                  onTap: () {
                    ref.read(sessionProvider.notifier).switchOrg(o.id);
                    Navigator.pop(ctx);
                  },
                ),
              if (!session.hasPersonal)
                ListTile(
                  leading: const Icon(Icons.person_outline),
                  title: const Text('Add my personal space'),
                  onTap: () async {
                    Navigator.pop(ctx);
                    try {
                      await ref.read(sessionProvider.notifier).createPersonal();
                    } catch (e) {
                      if (context.mounted) toastError(context, e);
                    }
                  },
                ),
              ListTile(
                leading: const Icon(Icons.add),
                title: const Text('Add a business space'),
                onTap: () async {
                  Navigator.pop(ctx);
                  final name = await promptText(context, title: 'New business space', label: 'Business name', action: 'Create');
                  if (name != null && name.isNotEmpty && context.mounted) {
                    try {
                      await ref.read(sessionProvider.notifier).createOrg(name);
                    } catch (e) {
                      if (context.mounted) toastError(context, e);
                    }
                  }
                },
              ),
            ],
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const QMark(size: 22),
            const SizedBox(width: 10),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    session.org?.name ?? 'Qline',
                    overflow: TextOverflow.ellipsis,
                    style: qs(15, w: FontWeight.w600, c: q.text),
                  ),
                  if (title.isNotEmpty) Text(title, style: qs(12, c: q.text3)),
                ],
              ),
            ),
            Icon(Icons.expand_more, size: 18, color: q.text3),
          ],
        ),
      ),
    );
  }
}

class _BottomNav extends ConsumerWidget {
  const _BottomNav({required this.index, required this.onTap, required this.orbKey, required this.fly});
  final int index;
  final ValueChanged<int> onTap;
  final GlobalKey orbKey;
  final AnimationController fly;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final reduce = ref.watch(prefsProvider).reduceMotion;
    final live = ref.watch(liveStatusProvider);
    final host = ref.watch(liveHostProvider);
    final orbState = host.mounted ? navCoreState(live.core) : CoreState.idle;
    final personal = ref.watch(sessionProvider.select((s) => s.personal));
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
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(sel ? active : icon, color: sel ? q.text : q.text3, size: 22),
                    const SizedBox(height: 4),
                    Text(
                      label,
                      style: qs(11, w: sel ? FontWeight.w600 : FontWeight.w500, c: sel ? q.text : q.text3),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(
        color: q.surface1,
        border: Border(top: BorderSide(color: q.line)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            item(0, Icons.space_dashboard_outlined, Icons.space_dashboard, 'Home'),
            item(1, Icons.check_circle_outline, Icons.check_circle, 'Work'),
            Expanded(
              child: Semantics(
                button: true,
                label: navOrbLabel(host.mounted ? live : const LiveStatus(), open: false),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: () => onTap(2),
                  child: SizedBox(
                    height: 64,
                    child: Center(
                      child: Container(
                        width: 56,
                        height: 56,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: QColors.liveInk,
                          border: Border.all(color: q.line),
                        ),
                        clipBehavior: Clip.antiAlias,
                        // The orb shows what Live AI is doing (listening, thinking, speaking, approval, disconnected).
                        // It hides while the core is flying to or from it.
                        child: ExcludeSemantics(
                          child: AnimatedBuilder(
                            animation: fly,
                            builder: (_, child) => Opacity(opacity: fly.isAnimating ? 0 : 1, child: child),
                            child: ValueListenableBuilder<double>(
                              valueListenable: liveLevel,
                              builder: (_, level, _) => EnergyCore(
                                key: orbKey,
                                state: orbState,
                                agent: live.template ?? 'ceo',
                                reduceMotion: reduce,
                                compact: true,
                                background: false,
                                level: host.view == LiveView.minimized ? level : 0,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            personal ? item(3, Icons.person_outline, Icons.person, 'Personal') : item(3, Icons.business_center_outlined, Icons.business_center, 'Business'),
            item(4, Icons.folder_outlined, Icons.folder, 'Library'),
          ],
        ),
      ),
    );
  }
}
