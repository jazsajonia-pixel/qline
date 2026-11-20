import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/config.dart';
import '../core/updater.dart';
import 'theme.dart';
import 'widgets.dart';

/// v1.11 (docs/28): "A new version is ready" banner. Never blocks the app; Later hides it for three days.
class UpdateBanner extends ConsumerWidget {
  const UpdateBanner({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(updaterProvider);
    final reduce = MediaQuery.of(context).disableAnimations;
    return AnimatedSize(
      duration: reduce ? Duration.zero : const Duration(milliseconds: 240),
      curve: Curves.easeOutCubic,
      alignment: Alignment.topCenter,
      child: s.showBanner ? Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 4), child: UpdateCard(state: s, compact: true)) : const SizedBox(width: double.infinity),
    );
  }
}

/// The update card, used by the banner and by Settings → App updates.
class UpdateCard extends ConsumerWidget {
  const UpdateCard({super.key, required this.state, this.compact = false});
  final UpdateState state;
  final bool compact;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final u = ref.read(updaterProvider.notifier);
    final rel = state.release!;
    final (IconData icon, String title, String body) = switch (state.phase) {
      UpdatePhase.downloading => (Icons.downloading, 'Downloading Qline ${rel.version}', state.progress == null ? 'Starting…' : '${(state.progress! * 100).round()}%${rel.size != null ? ' of ${(rel.size! / 1024 / 1024).toStringAsFixed(0)} MB' : ''}. You can keep using Qline.'),
      UpdatePhase.verifying => (Icons.verified_outlined, 'Checking the download', 'Making sure it matches the signed release.'),
      UpdatePhase.needsPermission => (Icons.lock_open_outlined, 'Allow Qline to install updates', 'Android asks once. Turn on "Allow from this source" for Qline, then come back.'),
      UpdatePhase.confirming => (Icons.system_update_outlined, 'Confirm on the Android screen', 'Tap Update. Qline closes, installs and opens again by itself.'),
      UpdatePhase.failed => (Icons.error_outline, 'Update not installed', state.message ?? 'Something went wrong.'),
      _ => (Icons.system_update_outlined, 'Qline ${rel.version} is available', state.message ?? 'You have ${state.current ?? AppConfig.version}. Update when it suits you; your chats and settings stay.'),
    };
    final busy = state.phase == UpdatePhase.downloading || state.phase == UpdatePhase.verifying;
    return Semantics(
      container: true,
      liveRegion: state.phase != UpdatePhase.downloading,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
        decoration: BoxDecoration(color: q.surface1, borderRadius: BorderRadius.circular(14), border: Border.all(color: (state.phase == UpdatePhase.failed ? q.bad : q.halo).withValues(alpha: .45))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, color: state.phase == UpdatePhase.failed ? q.bad : q.halo, size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: qs(15, w: FontWeight.w600, c: q.text)),
                const SizedBox(height: 2),
                Text(body, style: qs(13, c: q.text2, h: 1.35)),
              ]),
            ),
          ]),
          if (state.phase == UpdatePhase.downloading) ...[
            const SizedBox(height: 10),
            ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: state.progress, minHeight: 4, color: q.halo, backgroundColor: q.line)),
          ],
          const SizedBox(height: 6),
          Wrap(alignment: WrapAlignment.end, spacing: 4, runSpacing: 4, children: [
            if (rel.notes.isNotEmpty && !busy) TextButton(onPressed: () => showWhatsNew(context, rel), child: const Text("What's new")),
            if (state.phase == UpdatePhase.available || state.phase == UpdatePhase.failed) TextButton(key: const Key('update-later'), onPressed: () => u.later(), child: const Text('Later')),
            if (state.phase == UpdatePhase.failed)
              TextButton(onPressed: () => launchUrl(Uri.parse(rel.pageUrl ?? releasesPage), mode: LaunchMode.externalApplication), child: const Text('Release page')),
            switch (state.phase) {
              UpdatePhase.available => QButton('Update', key: const Key('update-now'), kind: QBtn.halo, icon: Icons.download, onPressed: () => u.update()),
              UpdatePhase.failed => QButton('Try again', kind: QBtn.halo, onPressed: () => u.update()),
              UpdatePhase.needsPermission => QButton('Open settings', key: const Key('update-settings'), kind: QBtn.halo, onPressed: () => u.openInstallSettings()),
              UpdatePhase.confirming => TextButton(onPressed: () => u.install(), child: const Text('Show again')),
              _ => const SizedBox.shrink(),
            },
          ]),
        ]),
      ),
    );
  }
}

Future<void> showWhatsNew(BuildContext context, AppRelease rel) => showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * .7),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text("What's new in ${rel.version}", style: qs(18, w: FontWeight.w600, c: ctx.q.text)),
              const SizedBox(height: 12),
              Text(rel.notes, style: qs(14, c: ctx.q.text2, h: 1.45)),
            ]),
          ),
        ),
      ),
    );

/// Settings → App updates: current version, manual check, and the same card.
class UpdatesScreen extends ConsumerWidget {
  const UpdatesScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final s = ref.watch(updaterProvider);
    final checking = s.phase == UpdatePhase.checking;
    return Page2(
      title: 'App updates',
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
        QCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            KV('Installed', s.current ?? AppConfig.version),
            if (s.release != null) KV('Latest', s.release!.version),
            const SizedBox(height: 8),
            Text(
              s.phase == UpdatePhase.upToDate ? 'Qline is up to date.' : 'Qline checks for updates when it opens and tells you when one is ready. Updates are never forced.',
              style: qs(13, c: q.text2, h: 1.4),
            ),
            if (s.release == null && s.message != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(s.message!, style: qs(13, c: q.warn))),
            const SizedBox(height: 12),
            QButton('Check for updates', key: const Key('update-check'), icon: Icons.refresh, busy: checking, expand: true, onPressed: () => ref.read(updaterProvider.notifier).check(manual: true)),
          ]),
        ),
        if (s.release != null && s.phase != UpdatePhase.upToDate) ...[const SizedBox(height: 12), UpdateCard(state: s)],
        const SizedBox(height: 16),
        Text('Updates come from the signed Qline releases on GitHub. Qline checks the download against the release checksum and Android checks it is signed with the same key as this app. Android always asks you to confirm the install.', style: qs(12, c: q.text3, h: 1.4)),
      ]),
    );
  }
}
