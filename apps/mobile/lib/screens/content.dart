import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/chat_artifacts.dart' show saveDeviceFile;
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'content_setup.dart';
import 'work.dart' show TaskDetail;

/// Content Studio (docs/22, run 6): video handoffs to an outside editor through Drive. Two states are always shown
/// apart: what Qline checked itself, and what the editor reports (untrusted until Qline checks the video).

/// What Qline's own state means: icon, colour, short word and the next step in plain language.
(IconData, Color, String, String) contentState(QColors q, String? s) => switch (s) {
      'prepared' => (Icons.outbox_outlined, q.info, 'Ready to send', 'Send the editor PDF to your editor.'),
      'dispatched' => (Icons.send_outlined, q.info, 'Sent to editor', 'Waiting for the editor to accept it.'),
      'external_acknowledged' => (Icons.mark_email_read_outlined, q.info, 'Editor accepted', 'Waiting for the editor to start.'),
      'external_in_progress' => (Icons.movie_edit, q.info, 'Editor working', 'Waiting for the finished video.'),
      'result_received' => (Icons.inbox_outlined, q.info, 'Result received', 'Qline will check the video next.'),
      'validating_output' => (Icons.manage_search, q.warn, 'Checking the video', 'Qline is checking the file in Ready for QA.'),
      'output_verified' => (Icons.verified_outlined, q.ok, 'Video checked', 'Qline found the right file. A review task is next.'),
      'awaiting_video_qa' => (Icons.rate_review_outlined, q.halo, 'Waiting for your review', 'Watch the video in Ready for QA, then finish the review task.'),
      'needs_manual_review' => (Icons.report_outlined, q.warn, 'Needs a check', 'Qline found a problem. See what it found below.'),
      'failed' => (Icons.error_outline, q.bad, 'Failed', 'The editor reported a failure. Reissue the job to try again.'),
      'blocked' => (Icons.block, q.bad, 'Blocked', 'The editor is stuck. Reissue the job with what they need.'),
      'expired' => (Icons.timer_off_outlined, q.text3, 'Expired', 'The job ran out of time. Reissue it to start again.'),
      'cancelled' => (Icons.cancel_outlined, q.text3, 'Cancelled', 'This job is closed.'),
      _ => (Icons.circle_outlined, q.text2, cap(s ?? 'unknown'), ''),
    };

/// What the editor last reported. Never a Qline decision.
String editorSays(String? s) => switch (s) {
      null => 'No report yet',
      'accepted' => 'Accepted',
      'in_progress' => 'In progress',
      'completed' => 'Says it is done',
      'failed' => 'Says it failed',
      'blocked' => 'Says it is blocked',
      'cancelled' => 'Says it is cancelled',
      _ => cap(s),
    };

/// The page a notification ref opens, if any. Refs come from the server ({kind, id}).
Widget? pageForRef(Object? ref) {
  final r = ref is String ? (() { try { return jsonDecode(ref); } catch (_) { return null; } })() : ref;
  if (r is! Map) return null;
  final id = r['id'];
  if (r['kind'] == 'content_job' && id is String && RegExp(r'^[0-9a-fA-F-]{36}$').hasMatch(id)) return ContentJobScreen(id: id);
  return null;
}

const _filters = [('active', 'Active'), ('awaiting', 'Your review'), ('attention', 'Needs a check'), ('failed', 'Failed'), ('all', 'All')];

/// Command Center → Content Studio: Drive setup at the top, then the Handoff Monitor.
class ContentStudioScreen extends ConsumerStatefulWidget {
  const ContentStudioScreen({super.key});
  @override
  ConsumerState<ContentStudioScreen> createState() => _StudioState();
}

class _StudioState extends ConsumerState<ContentStudioScreen> {
  String _filter = 'active';
  int _gen = 0;
  bool _checking = false;

  Future<void> _checkReports() async {
    setState(() => _checking = true);
    final r = await act(context, ref, (api) => api.post('/content/reports/check'));
    if (mounted) setState(() => _checking = false);
    if (r is Map && mounted) {
      final applied = (r['applied'] as num?) ?? 0, rejected = (r['rejected'] as num?) ?? 0;
      toast(context, applied == 0 && rejected == 0 ? 'No new reports.' : '$applied new report${applied == 1 ? '' : 's'} read${rejected > 0 ? ', $rejected refused' : ''}.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    return Load<Map>(
      key: ValueKey('$_filter$_gen'),
      fetch: (api) async {
        try {
          final cfg = await api.get('/content/drive-config') as Map?;
          final jobs = await api.get('/content/jobs', {'filter': _filter}) as Map;
          return {'cfg': cfg, 'jobs': jobs};
        } on ApiException catch (e) {
          // A server from before Content Studio has no content routes: say so instead of an error.
          if (e.status == 404) return {'unavailable': true};
          rethrow;
        }
      },
      builder: (context, d, reload) {
        final ready = d['cfg'] is Map && (d['cfg'] as Map)['status'] == 'valid';
        return Page2(
          title: 'Content Studio',
          fab: ready && s.canWrite
              ? FloatingActionButton.extended(
                  onPressed: () async {
                    final id = await push<String>(context, const NewHandoffScreen());
                    if (id != null && context.mounted) await push(context, ContentJobScreen(id: id));
                    if (mounted) setState(() => _gen++);
                  },
                  icon: const Icon(Icons.add),
                  label: const Text('New handoff'),
                )
              : null,
          body: d['unavailable'] == true
              ? const EmptyState(icon: Icons.cloud_sync_outlined, title: 'Content Studio is not on your server yet', body: 'Your Qline server needs the Content Studio update before video handoffs can be used. Everything else works as before.')
              : _body(context, q, s, (d['cfg'] as Map?)?.cast<String, dynamic>(), items(d['jobs']), reload),
        );
      },
    );
  }

  Widget _body(BuildContext context, QColors q, SessionState s, Map<String, dynamic>? cfg, List<Map<String, dynamic>> jobs, Future<void> Function() reload) {
    final ready = cfg?['status'] == 'valid';
    final hasReports = (cfg?['roles'] as Map?)?['external_reports'] != null;
    return RefreshIndicator(
      onRefresh: reload,
      child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 96), children: [
        Text('Send video jobs to your editor through Google Drive. Qline checks every finished video itself before you review it.', style: qs(14, c: q.text2)),
        const SizedBox(height: 12),
        QCard(
          onTap: () async {
            await push(context, const DriveFolderSetupScreen());
            if (mounted) setState(() => _gen++);
          },
          child: Row(children: [
            Expanded(child: DriveStatusLine(cfg: cfg ?? const {})),
            Icon(Icons.chevron_right, color: q.text3),
          ]),
        ),
        if (ready && hasReports && s.canWrite) ...[
          const SizedBox(height: 8),
          Align(alignment: Alignment.centerLeft, child: QButton('Check Drive for reports', kind: QBtn.ghost, icon: Icons.inbox_outlined, busy: _checking, onPressed: _checking ? null : _checkReports)),
        ],
        const SectionLabel('Handoff monitor'),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (final (id, label) in _filters)
              Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(label: Text(label), selected: _filter == id, onSelected: (_) => setState(() => _filter = id))),
          ]),
        ),
        const SizedBox(height: 10),
        if (jobs.isEmpty)
          EmptyState(
            icon: Icons.movie_outlined,
            title: _filter == 'active' || _filter == 'all' ? 'No handoffs yet' : 'Nothing here',
            body: !ready
                ? (s.canManage ? 'Set up the Drive folders first. Then create a handoff from your source files.' : 'An owner or admin needs to set up the Drive folders first.')
                : _filter == 'active' || _filter == 'all'
                    ? (s.canWrite ? 'Tap New handoff to package source files for your editor.' : 'Handoffs your team creates show up here.')
                    : 'No jobs match this filter.',
          )
        else
          for (final (i, j) in jobs.indexed)
            Reveal(
              index: i,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: JobRow(
                  job: j,
                  onTap: () async {
                    await push(context, ContentJobScreen(id: j['id'] as String));
                    await reload();
                  },
                ),
              ),
            ),
      ]),
    );
  }
}

/// Qline's state as icon + word, never colour alone.
class ContentStatePill extends StatelessWidget {
  const ContentStatePill(this.state, {super.key});
  final String? state;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final (icon, col, word, _) = contentState(q, state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: col.withValues(alpha: .1), borderRadius: BorderRadius.circular(999), border: Border.all(color: col.withValues(alpha: .4))),
      child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 13, color: col), const SizedBox(width: 4), Flexible(child: Text(word, overflow: TextOverflow.ellipsis, style: qs(12, w: FontWeight.w600, c: col)))]),
    );
  }
}

class JobRow extends StatelessWidget {
  const JobRow({super.key, required this.job, required this.onTap});
  final Map job;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final (_, _, word, _) = contentState(q, job['state'] as String?);
    final stale = job['stale'] == true;
    return Semantics(
      button: true,
      label: '${job['title']}. Qline: $word. Editor: ${editorSays(job['externalStatus'] as String?)}.${stale ? ' No news for over 3 days.' : ''}',
      excludeSemantics: true,
      child: QCard(
        onTap: onTap,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${job['title']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
          const SizedBox(height: 2),
          Text('${job['jobCode']} · revision ${job['revision']}', style: qs(12, c: q.text3, family: mono)),
          const SizedBox(height: 10),
          Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            ContentStatePill(job['state'] as String?),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.chat_bubble_outline, size: 13, color: q.text3),
              const SizedBox(width: 4),
              Text('Editor: ${editorSays(job['externalStatus'] as String?)}', style: qs(12, c: q.text2)),
            ]),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            if (stale) ...[Icon(Icons.hourglass_empty, size: 13, color: q.warn), const SizedBox(width: 4), Text('No news for 3+ days', style: qs(12, w: FontWeight.w600, c: q.warn)), const SizedBox(width: 10)],
            Expanded(child: Text('Updated ${ago(job['lastActivityAt'] as String?)}', textAlign: stale ? TextAlign.end : TextAlign.start, style: qs(12, c: q.text3))),
          ]),
        ]),
      ),
    );
  }
}

/// Package indexed source files for the editor. Pops with the new job's ID.
class NewHandoffScreen extends ConsumerStatefulWidget {
  const NewHandoffScreen({super.key});
  @override
  ConsumerState<NewHandoffScreen> createState() => _NewHandoffState();
}

class _NewHandoffState extends ConsumerState<NewHandoffScreen> {
  final _title = TextEditingController();
  final _brief = TextEditingController();
  final _picked = <String>{};
  String? _ratio;
  bool _busy = false;

  @override
  void dispose() {
    _title.dispose();
    _brief.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    setState(() => _busy = true);
    final r = await act(context, ref, (api) => api.post('/content/jobs', {
          'title': _title.text.trim(),
          'brief': _brief.text.trim(),
          'assetIds': _picked.toList(),
          if (_ratio != null) 'constraints': {'aspectRatio': _ratio},
        }), ok: 'Handoff created. Send the editor PDF to your editor.');
    if (!mounted) return;
    setState(() => _busy = false);
    if (r is Map) Navigator.pop(context, r['id'] as String);
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final ok = _title.text.trim().isNotEmpty && _picked.isNotEmpty && !_busy;
    return Page2(
      title: 'New handoff',
      body: Load<Map>(
        fetch: (api) async => await api.get('/content/assets', {'role': 'assets', 'limit': 100}) as Map,
        builder: (context, d, reload) {
          final files = items(d);
          return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
            TextField(controller: _title, maxLength: 120, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Title', hintText: 'For example: Spring promo, 30 seconds')),
            const SizedBox(height: 8),
            TextField(controller: _brief, maxLength: 4000, minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'Brief for the editor', helperText: 'What to make, the mood, must-have shots. It goes into the editor PDF.', helperMaxLines: 2)),
            const SectionLabel('Shape'),
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final r in const [null, '9:16', '16:9', '1:1', '4:5'])
                ChoiceChip(label: Text(r ?? 'Any'), selected: _ratio == r, onSelected: (_) => setState(() => _ratio = r)),
            ]),
            SectionLabel('Source files · ${_picked.length} picked'),
            if (files.isEmpty)
              const EmptyState(icon: Icons.perm_media_outlined, title: 'No source files yet', body: 'Put files in a Source files folder, then sync the Drive folders from Content Studio.')
            else
              QCard(
                padding: EdgeInsets.zero,
                child: Column(children: [
                  for (final (i, f) in files.indexed) ...[
                    if (i > 0) const Divider(),
                    CheckboxListTile(
                      value: _picked.contains(f['driveFileId']),
                      onChanged: _busy || (!_picked.contains(f['driveFileId']) && _picked.length >= 50)
                          ? null
                          : (v) => setState(() => v == true ? _picked.add(f['driveFileId'] as String) : _picked.remove(f['driveFileId'])),
                      title: Text('${f['name']}', maxLines: 2, overflow: TextOverflow.ellipsis),
                      subtitle: Text([fileKind(f['mime'] as String?), if (f['sizeBytes'] != null) bytesLabel(f['sizeBytes'])].join(' · ')),
                      controlAffinity: ListTileControlAffinity.leading,
                    ),
                  ],
                ]),
              ),
            if (files.length >= 100) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Showing the first 100 files.', style: qs(12, c: q.text3))),
            const SizedBox(height: 16),
            QButton('Create handoff', kind: QBtn.halo, icon: Icons.outbox_outlined, expand: true, busy: _busy, onPressed: ok ? _create : null),
            if (!ok && !_busy) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Add a title and pick at least one file.', style: qs(12, c: q.text3))),
          ]);
        },
      ),
    );
  }
}

String fileKind(String? mime) => switch (mime?.split('/').first) { 'video' => 'Video', 'image' => 'Image', 'audio' => 'Audio', 'text' => 'Text', _ => 'File' };

String bytesLabel(Object? v) {
  final n = v is num ? v : num.tryParse('$v') ?? 0;
  return n < 1024 ? '$n B' : n < 1048576 ? '${(n / 1024).toStringAsFixed(0)} KB' : n < 1073741824 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${(n / 1073741824).toStringAsFixed(2)} GB';
}

const _closed = ['cancelled', 'expired'];
const _noReissue = ['cancelled', 'output_verified', 'awaiting_video_qa'];

/// One handoff: both states, what to do next, files, findings and the timeline.
class ContentJobScreen extends ConsumerStatefulWidget {
  const ContentJobScreen({super.key, required this.id});
  final String id;
  @override
  ConsumerState<ContentJobScreen> createState() => _JobState();
}

class _JobState extends ConsumerState<ContentJobScreen> {
  String? _busy;

  Future<void> _run(String key, Future<dynamic> Function(Api api) fn, Future<void> Function() reload, {String? ok}) async {
    setState(() => _busy = key);
    final r = await act(context, ref, fn, ok: ok);
    if (mounted) setState(() => _busy = null);
    if (r != null) await reload();
  }

  /// Saves Qline's stored copy: the editor PDF, the manifest or the latest acknowledgement.
  Future<void> _save(Map j, String kind, {Map? ack}) async {
    final name = switch (kind) {
      'pdf' => '${j['jobCode']}-r${j['revision']}.pdf',
      'ack' => '${j['jobCode']}-r${ack?['revision']}.ack-${ack?['version']}.json',
      _ => '${j['jobCode']}-r${j['revision']}.manifest.json',
    };
    setState(() => _busy = kind);
    try {
      final bytes = await ref.read(apiProvider).download('/content/jobs/${j['id']}/${kind == 'ack' ? 'ack?version=${ack?['version']}' : kind}');
      final where = await saveDeviceFile(name, bytes);
      if (mounted) toast(context, where == null ? 'Not saved' : 'Saved $name');
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _paste(Map j, Future<void> Function() reload) async {
    final clip = (await Clipboard.getData('text/plain'))?.text;
    if (!mounted) return;
    final text = await promptText(context, title: 'Paste the result file', label: 'Contents of ${j['jobCode']}-r${j['revision']}.result.json', initial: clip, action: 'Read it', maxLines: 8);
    if (text == null || text.isEmpty || !mounted) return;
    setState(() => _busy = 'paste');
    try {
      final r = await ref.read(apiProvider).postRaw('/content/jobs/${j['id']}/ingest', text) as Map;
      ref.read(refreshTick.notifier).bump();
      if (mounted) {
        toast(context, switch (r['outcome']) {
          'applied' => 'Report read. Qline updated the job.',
          'duplicate' => 'Qline already had this report.',
          'recorded' => 'Report saved. It does not change the job now.',
          _ => 'Qline refused this report. See the timeline for why.',
        });
      }
      await reload();
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    return Page2(
      title: 'Handoff',
      body: Load<Map>(
        fetch: (api) async {
          final j = (await api.get('/content/jobs/${widget.id}') as Map).cast<String, dynamic>();
          Object? manifest;
          try {
            manifest = await api.get('/content/jobs/${widget.id}/manifest');
          } on ApiException catch (e) {
            manifest = e; // shown as a warning; the job itself still loads
          }
          return {...j, '_manifest': manifest};
        },
        builder: (context, j, reload) => _detail(context, q, s, j.cast<String, dynamic>(), reload),
      ),
    );
  }

  Widget _detail(BuildContext context, QColors q, SessionState s, Map<String, dynamic> j, Future<void> Function() reload) {
    final state = j['state'] as String?;
    final (_, col, _, next) = contentState(q, state);
    final manifest = j['_manifest'];
    final inputs = manifest is Map ? items(manifest, 'inputs') : const <Map<String, dynamic>>[];
    final outputs = items(j, 'outputs');
    final acks = items(j, 'acks');
    final events = items(j, 'events').reversed.toList();
    final findings = acks.isEmpty ? const <Map<String, dynamic>>[] : items(acks.last, 'findings');
    final closed = _closed.contains(state);
    final write = s.canWrite;
    final hasDeferred = state == 'validating_output' && j['lastError'] != null;
    return RefreshIndicator(
      onRefresh: reload,
      child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 40), children: [
        Text('${j['title']}', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 4),
        Row(children: [
          Flexible(child: SelectableText('${j['jobCode']}', style: qs(13, c: q.text2, family: mono))),
          Text('  ·  revision ${j['revision']}', style: qs(13, c: q.text3)),
        ]),
        const SizedBox(height: 14),
        // The two ledgers: Qline's own check, then the editor's claim.
        QCard(
          accent: col.withValues(alpha: .45),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _Ledger(icon: Icons.shield_outlined, who: 'Qline checked', child: ContentStatePill(state)),
            if (next.isNotEmpty) Padding(padding: const EdgeInsets.only(left: 30, top: 4), child: Text(next, style: qs(13, c: q.text2))),
            const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Divider()),
            _Ledger(icon: Icons.chat_bubble_outline, who: 'Editor says', child: Text(editorSays(j['externalStatus'] as String?), style: qs(14, w: FontWeight.w600, c: q.text))),
            Padding(padding: const EdgeInsets.only(left: 30, top: 4), child: Text('What the editor reports is not trusted until Qline checks the video itself.', style: qs(12, c: q.text3))),
          ]),
        ),
        if (j['stale'] == true) _Note(icon: Icons.hourglass_empty, color: q.warn, text: 'No news from the editor for over 3 days (since ${dateLabel(j['lastActivityAt'] as String?)}). Check in with them.'),
        if (j['lastError'] != null) _Note(icon: Icons.cloud_off_outlined, color: q.warn, text: '${j['lastError']}'),
        if (j['cancelReason'] != null) _Note(icon: Icons.cancel_outlined, color: q.text3, text: 'Cancel reason: ${j['cancelReason']}'),
        if (manifest is ApiException) _Note(icon: Icons.error_outline, color: q.bad, text: manifest.code == 'INTEGRITY_FAILED' ? "The stored job files don't match their checksum. Don't send this job. Reissue it." : "Couldn't load the job files: ${manifest.message}"),
        if (!closed && j['expiresAt'] != null) Padding(padding: const EdgeInsets.only(top: 10, left: 4), child: Text('Open until ${dateLabel(j['expiresAt'] as String?)}', style: qs(12, c: q.text3))),
        // The one main action for this state.
        if (state == 'awaiting_video_qa' && j['qaTaskId'] != null) ...[
          const SizedBox(height: 14),
          QButton('Open review task', kind: QBtn.halo, icon: Icons.rate_review_outlined, expand: true, onPressed: () => push(context, TaskDetail(id: j['qaTaskId'] as String))),
        ] else if (hasDeferred && write) ...[
          const SizedBox(height: 14),
          QButton('Check the video again', kind: QBtn.halo, icon: Icons.refresh, expand: true, busy: _busy == 'verify', onPressed: _busy != null ? null : () => _run('verify', (api) => api.post('/content/jobs/${j['id']}/verify'), reload, ok: 'Checked again.')),
        ],
        const SectionLabel('For your editor'),
        Wrap(spacing: 8, runSpacing: 8, children: [
          QButton('Save editor PDF', kind: state == 'prepared' ? QBtn.halo : QBtn.secondary, icon: Icons.picture_as_pdf_outlined, busy: _busy == 'pdf', onPressed: _busy != null || manifest is ApiException ? null : () => _save(j, 'pdf')),
          QButton('Save manifest', icon: Icons.data_object, busy: _busy == 'manifest', onPressed: _busy != null || manifest is ApiException ? null : () => _save(j, 'manifest')),
          if (acks.isNotEmpty) QButton("Save Qline's receipt", icon: Icons.receipt_long_outlined, busy: _busy == 'ack', onPressed: _busy != null ? null : () => _save(j, 'ack', ack: acks.last)),
        ]),
        Padding(padding: const EdgeInsets.only(top: 6, left: 4), child: Text('Send both to your editor. They hold this revision\'s security code, so share them only with the editor.', style: qs(12, c: q.text3))),
        SectionLabel('Source files · ${inputs.isEmpty ? (j['inputFileIds'] as List?)?.length ?? 0 : inputs.length}'),
        if (inputs.isEmpty)
          Text('File names are in the manifest, which could not be loaded.', style: qs(13, c: q.text3))
        else
          QCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Column(children: [
              for (final f in inputs)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(children: [
                    Icon(Icons.lock_outline, size: 16, color: q.text3, semanticLabel: 'Read only'),
                    const SizedBox(width: 10),
                    Expanded(child: Text('${f['name']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text))),
                    Text([fileKind(f['mimeType'] as String?), if (f['sizeBytes'] != null) bytesLabel(f['sizeBytes'])].join(' · '), style: qs(12, c: q.text3)),
                  ]),
                ),
            ]),
          ),
        const SectionLabel('Finished video'),
        if (outputs.isEmpty)
          Text('Nothing yet. Qline looks for ${((j['expectedOutputs'] as List?)?.firstOrNull as Map?)?['fileName'] ?? 'the video'} in Ready for QA.', style: qs(13, c: q.text3))
        else
          for (final o in outputs) _Output(o: o),
        if (findings.isNotEmpty) ...[
          const SectionLabel('What Qline found'),
          QCard(
            accent: q.warn.withValues(alpha: .45),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final f in findings) _Finding(f: f)]),
          ),
        ],
        const SectionLabel('Timeline'),
        if (events.isEmpty) Text('Nothing yet.', style: qs(13, c: q.text3)) else for (final e in events) _Event(e: e),
        if (write && !closed) ...[
          const SectionLabel('More actions'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            QButton('Paste a result file', icon: Icons.content_paste, busy: _busy == 'paste', onPressed: _busy != null ? null : () => _paste(j, reload)),
            if (!_noReissue.contains(state))
              QButton('Reissue', icon: Icons.restart_alt, busy: _busy == 'reissue', onPressed: _busy != null
                  ? null
                  : () async {
                      final rev = j['revision'] as num;
                      if (!await confirm(context, title: 'Reissue as revision ${rev + 1}?', body: 'Qline makes a new PDF and manifest with a new security code. Results for revision $rev stop counting, so send the new PDF to your editor.', action: 'Reissue')) return;
                      if (context.mounted) await _run('reissue', (api) => api.post('/content/jobs/${j['id']}/reissue', {'revision': rev}), reload, ok: 'Reissued. Send the new PDF to your editor.');
                    }),
            QButton('Cancel job', kind: QBtn.destructive, icon: Icons.cancel_outlined, busy: _busy == 'cancel', onPressed: _busy != null
                ? null
                : () async {
                    if (!await confirm(context, title: 'Cancel this job?', body: 'Qline stops tracking it and refuses later reports. Nothing in Drive is deleted.', action: 'Cancel job', destructive: true)) return;
                    if (context.mounted) await _run('cancel', (api) => api.post('/content/jobs/${j['id']}/cancel', {'confirm': true}), reload, ok: 'Job cancelled.');
                  }),
          ]),
        ] else if (!write)
          Padding(padding: const EdgeInsets.only(top: 20), child: Text('You can view this job. Members and above can change it.', style: qs(13, c: q.text3))),
      ]),
    );
  }
}

class _Ledger extends StatelessWidget {
  const _Ledger({required this.icon, required this.who, required this.child});
  final IconData icon;
  final String who;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Row(children: [
      Icon(icon, size: 20, color: q.text2),
      const SizedBox(width: 10),
      Expanded(child: Text(who, style: qs(13, w: FontWeight.w500, c: q.text2))),
      Flexible(child: Align(alignment: Alignment.centerRight, child: child)),
    ]);
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.color, required this.text});
  final IconData icon;
  final Color color;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: QCard(
          accent: color.withValues(alpha: .5),
          padding: const EdgeInsets.all(12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: qs(13, c: context.q.text))),
          ]),
        ),
      );
}

class _Output extends StatelessWidget {
  const _Output({required this.o});
  final Map o;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final ok = o['verification'] == 'verified';
    final findings = items(o, 'findings');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: QCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(Icons.movie_outlined, size: 18, color: q.text2),
            const SizedBox(width: 10),
            Expanded(child: Text('${o['name']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, w: FontWeight.w600, c: q.text))),
            const SizedBox(width: 8),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(ok ? Icons.verified_outlined : Icons.error_outline, size: 15, color: ok ? q.ok : q.bad),
              const SizedBox(width: 4),
              Text(ok ? 'Checked by Qline' : 'Refused', style: qs(12, w: FontWeight.w600, c: ok ? q.ok : q.bad)),
            ]),
          ]),
          if (o['size_bytes'] != null) Padding(padding: const EdgeInsets.only(left: 28, top: 2), child: Text('${bytesLabel(o['size_bytes'])} · revision ${o['revision']}', style: qs(12, c: q.text3))),
          for (final f in findings) Padding(padding: const EdgeInsets.only(left: 28, top: 6), child: _Finding(f: f)),
        ]),
      ),
    );
  }
}

class _Finding extends StatelessWidget {
  const _Finding({required this.f});
  final Map f;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.report_outlined, size: 15, color: context.q.warn),
          const SizedBox(width: 8),
          Expanded(child: Text('${f['message']}', style: qs(13, c: context.q.text))),
        ]),
      );
}

/// Timeline entry. Editor text is shown as the editor's words, never as Qline's.
class _Event extends StatelessWidget {
  const _Event({required this.e});
  final Map e;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final src = e['source'] as String?;
    final type = e['event_type'] as String? ?? '';
    final (icon, who) = switch (src) { 'external' => (Icons.chat_bubble_outline, 'Editor'), 'drive' => (Icons.folder_outlined, 'Drive'), _ => (Icons.shield_outlined, 'Qline') };
    final title = switch (type) {
      'job.created' => 'Job created',
      'job.reissued' => 'Reissued',
      'job.cancelled' => 'Cancelled',
      'job.stale' => 'No news for 3 days',
      'state.changed' => 'State changed',
      'report.rejected' => 'Report refused',
      'qa.created' => 'Review task created',
      'output.tampered' => 'Video changed after the check',
      _ when type.startsWith('report.') => 'Report: ${editorSays(type.substring(7))}',
      _ => cap(type.replaceAll('.', ' ')),
    };
    final msg = (e['message'] as String?)?.trim() ?? '';
    final editorText = src == 'external' && type != 'report.rejected';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 16, color: src == 'external' ? q.text3 : q.text2),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('$who · $title', style: qs(13, w: FontWeight.w600, c: q.text)),
            if (msg.isNotEmpty)
              editorText
                  ? Container(
                      margin: const EdgeInsets.only(top: 4),
                      padding: const EdgeInsets.only(left: 10),
                      decoration: BoxDecoration(border: Border(left: BorderSide(color: q.lineStrong, width: 2))),
                      child: Text('Editor wrote: $msg', maxLines: 6, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2)),
                    )
                  : Text(msg, style: qs(13, c: q.text2)),
            Text('r${e['revision'] ?? ''} · ${ago((e['occurred_at'] ?? e['received_at']) as String?)}', style: qs(11, c: q.text3)),
          ]),
        ),
      ]),
    );
  }
}
