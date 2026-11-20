import 'dart:math';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'approvals.dart';

/// v1.11 (docs/27): Facebook Pages. Facebook only (no Instagram or other platforms yet).
/// Nothing is posted until the person reviews the exact post and taps Publish / Schedule. The server checks that what
/// is sent is exactly what was reviewed (content hash). AI-written posts wait in Approvals.

Map<String, dynamic> _m(dynamic v) => (v as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

const fbMaxBytes = 10 * 1024 * 1024;
const fbMessageMax = 5000;
const fbPhotoExt = ['jpg', 'jpeg', 'png', 'gif'];
const fbVideoExt = ['mp4', 'mov'];

/// A photo or video picked for a post. Tests replace the picker.
typedef FbMedia = ({String name, Uint8List bytes});
Future<FbMedia?> Function(bool video) pickFacebookMedia = (video) async {
  final files = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: video ? fbVideoExt : fbPhotoExt);
  if (files.isEmpty) return null;
  return (name: files.first.name, bytes: await files.first.readAsBytes());
};

/// Facebook's scheduling window, with Qline's one-minute margin (see services/api/src/integrations/facebook.ts).
const fbScheduleMin = Duration(minutes: 11), fbScheduleMax = Duration(days: 30);

/// Plain words for a post's status.
String fbStatusWord(String s) => switch (s) {
      'published' => 'Published',
      'scheduled' => 'Scheduled',
      'processing' => 'Facebook is processing the video',
      'publishing' => 'Sending to Facebook',
      'failed' => 'Failed',
      'cancelled' => 'Cancelled',
      'unknown' => 'Outcome unknown, check Facebook',
      _ => s,
    };

String _requestKey() {
  final r = Random.secure();
  return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

String _when(String? iso) {
  if (iso == null) return '';
  final d = DateTime.tryParse(iso)?.toLocal();
  if (d == null) return '';
  String two(int n) => n.toString().padLeft(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '${months[d.month - 1]} ${d.day}, ${d.year} · $h:${two(d.minute)} ${d.hour < 12 ? 'AM' : 'PM'}';
}

Future<void> _openUrl(BuildContext context, String? url) async {
  if (url == null) return;
  final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) toast(context, 'Could not open Facebook.');
}

class FacebookScreen extends ConsumerWidget {
  const FacebookScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(refreshTick);
    final q = context.q;
    return Page2(
      title: 'Facebook Pages',
      body: Load<(Map<String, dynamic>, Map<String, dynamic>)>(
        fetch: (api) async => (_m(await api.get('/facebook/pages')), _m(await api.get('/facebook/posts'))),
        builder: (context, d, reload) {
          final (pg, ps) = d;
          final conn = _m(pg['connection']);
          final pages = items(pg, 'pages');
          final posts = items(ps, 'posts');
          final waiting = items(ps, 'awaitingApproval');
          final postable = pages.where((p) => p['canPost'] == true).toList();
          final expired = conn['status'] != null && conn['status'] != 'ok';
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
              QCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [Icon(Icons.verified_user_outlined, color: q.halo, size: 20), const SizedBox(width: 8), Expanded(child: Text('How Qline posts to Facebook', style: qs(15, w: FontWeight.w600, c: q.text)))]),
                  const SizedBox(height: 8),
                  for (final g in const [
                    'Nothing is posted until you review the exact post and approve it.',
                    'Posts the AI writes wait in Approvals, even on full autopilot.',
                    'Only Facebook Pages you manage. No Instagram, groups or personal profiles.',
                  ])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Padding(padding: const EdgeInsets.only(top: 2), child: Icon(Icons.check, size: 16, color: q.ok)), const SizedBox(width: 8), Expanded(child: Text(g, style: qs(13, c: q.text2, h: 1.4)))]),
                    ),
                ]),
              ),
              if (expired) ...[
                const SizedBox(height: 12),
                QCard(child: Text((conn['statusDetail'] as String?) ?? 'Facebook needs to be reconnected in Settings → Integrations.', style: qs(14, c: q.warn))),
              ],
              const SectionLabel('Pages'),
              if (pages.isEmpty)
                const EmptyState(icon: Icons.flag_outlined, title: 'No Pages yet', body: 'Qline found no Facebook Pages for this account. Make sure you manage a Page, then reconnect Facebook and choose it.')
              else
                for (final p in pages)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: QCard(
                      onTap: p['canPost'] == true && !expired ? () => _compose(context, p, conn['canPostVideo'] == true) : null,
                      child: Row(children: [
                        Icon(Icons.flag_outlined, color: p['canPost'] == true ? q.halo : q.text3),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('${p['name']}', style: qs(15, w: FontWeight.w600, c: q.text)),
                            Text(p['canPost'] == true ? (p['category'] as String? ?? 'Facebook Page') : 'You can\'t create posts on this Page', style: qs(13, c: q.text2)),
                          ]),
                        ),
                        if (p['canPost'] == true && !expired) Text('New post', style: qs(13, w: FontWeight.w600, c: q.halo)),
                      ]),
                    ),
                  ),
              if (postable.isNotEmpty && waiting.isNotEmpty) ...[
                SectionLabel('Waiting for your approval', trailing: TextButton(onPressed: () => push(context, const ApprovalsScreen()), child: Text('Open Approvals', style: qs(13, w: FontWeight.w600, c: q.text2)))),
                for (final w in waiting)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: QCard(
                      onTap: () => push(context, const ApprovalsScreen()),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [Expanded(child: Text('${w['title']}', style: qs(14, w: FontWeight.w600, c: q.text))), const StatusPill('awaiting_approval')]),
                        for (final l in (w['lines'] as List? ?? const []).take(3)) Text('$l', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2)),
                      ]),
                    ),
                  ),
              ],
              const SectionLabel('Posts'),
              if (posts.isEmpty)
                EmptyState(icon: Icons.edit_note, title: 'No posts yet', body: postable.isEmpty ? 'Connect a Page you manage to start.' : 'Tap a Page above to write your first post.')
              else
                for (final p in posts) FacebookPostTile(p, onChanged: reload),
            ]),
          );
        },
      ),
    );
  }

  Future<void> _compose(BuildContext context, Map<String, dynamic> page, bool canVideo) async {
    await push(context, FacebookComposeScreen(page: page, canPostVideo: canVideo));
  }
}

class FacebookPostTile extends ConsumerWidget {
  const FacebookPostTile(this.p, {super.key, required this.onChanged});
  final Map<String, dynamic> p;
  final Future<void> Function() onChanged;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final status = p['status'] as String;
    final scheduled = status == 'scheduled';
    final text = (p['message'] as String?)?.trim() ?? '';
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: QCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('${p['pageName'] ?? 'Facebook Page'} · ${switch (p['kind']) { 'link' => 'Link', 'photo' => 'Photo', 'video' => 'Video', _ => 'Text' }}', style: qs(13, w: FontWeight.w600, c: q.text2))),
            Semantics(label: fbStatusWord(status), child: ExcludeSemantics(child: StatusPill(status))),
          ]),
          const SizedBox(height: 6),
          if (text.isNotEmpty) Text(text, maxLines: 4, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text, h: 1.4)),
          if (p['mediaName'] != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${p['mediaName']}', style: qs(12, c: q.text3))),
          const SizedBox(height: 6),
          Text(
            scheduled
                ? 'Goes live ${_when(p['scheduleAt'] as String?)}'
                : status == 'published'
                    ? 'Published ${_when((p['publishedAt'] ?? p['createdAt']) as String?)}${p['source'] == 'agent' ? ' · written by the AI' : ''}'
                    : status == 'processing' || status == 'publishing'
                        ? fbStatusWord(status)
                        : 'Created ${_when(p['createdAt'] as String?)}',
            style: qs(12, c: q.text2),
          ),
          if (p['error'] != null && (status == 'failed' || status == 'unknown')) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${p['error']}', style: qs(13, c: status == 'failed' ? q.bad : q.warn))),
          if (p['permalink'] != null || scheduled || status == 'processing')
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(spacing: 8, runSpacing: 8, children: [
                if (p['permalink'] != null) QButton('View on Facebook', icon: Icons.open_in_new, onPressed: () => _openUrl(context, p['permalink'] as String)),
                if (status == 'processing' || scheduled)
                  QButton('Check status', icon: Icons.refresh, kind: QBtn.ghost, onPressed: () async {
                    await act(context, ref, (api) => api.get('/facebook/posts/${p['id']}'));
                    await onChanged();
                  }),
                if (scheduled)
                  QButton('Cancel post', kind: QBtn.destructive, onPressed: () async {
                    final ok = await confirm(context, title: 'Cancel this scheduled post?', body: 'Qline removes it from Facebook before it goes live. This can\'t be undone, but you can write it again.', action: 'Cancel post', destructive: true);
                    if (!ok || !context.mounted) return;
                    await act(context, ref, (api) => api.post('/facebook/posts/${p['id']}/cancel', {'confirm': true}), ok: 'Scheduled post cancelled');
                    await onChanged();
                  }),
              ]),
            ),
        ]),
      ),
    );
  }
}

/// Write a post, review exactly what will be posted, then approve it.
class FacebookComposeScreen extends ConsumerStatefulWidget {
  const FacebookComposeScreen({super.key, required this.page, this.canPostVideo = false, this.now});
  final Map<String, dynamic> page;
  final bool canPostVideo;
  final DateTime Function()? now;
  @override
  ConsumerState<FacebookComposeScreen> createState() => _ComposeState();
}

class _ComposeState extends ConsumerState<FacebookComposeScreen> {
  final _msg = TextEditingController();
  final _link = TextEditingController();
  final _title = TextEditingController();
  String _kind = 'text';
  FbMedia? _media;
  String? _fileId;
  DateTime? _at;
  bool _busy = false;
  String? _error;

  DateTime get _now => (widget.now ?? DateTime.now)();

  @override
  void dispose() {
    _msg.dispose();
    _link.dispose();
    _title.dispose();
    super.dispose();
  }

  Map<String, dynamic> get _draft => {
        'pageRef': widget.page['id'],
        'kind': _kind,
        'message': _msg.text.trim(),
        if (_kind == 'link') 'link': _link.text.trim(),
        if (_kind == 'video' && _title.text.trim().isNotEmpty) 'title': _title.text.trim(),
        if (_kind == 'photo' || _kind == 'video') 'fileId': _fileId,
        if (_at != null) 'scheduleAt': _at!.toUtc().toIso8601String(),
      };

  Future<void> _pick() async {
    final m = await pickFacebookMedia(_kind == 'video');
    if (m == null || !mounted) return;
    if (m.bytes.length > fbMaxBytes) {
      setState(() => _error = 'That file is over 10 MB. Pick a smaller one.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = _m(await ref.read(apiProvider).upload('/facebook/media', m.name, m.bytes));
      if (!mounted) return;
      final kind = r['kind'] as String?;
      if (kind != (_kind == 'video' ? 'video' : 'photo')) throw ApiException(400, 'WRONG_KIND', _kind == 'video' ? 'That is not a video.' : 'That is not a photo.');
      setState(() {
        _media = m;
        _fileId = r['id'] as String;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : 'Upload failed. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pickTime() async {
    final now = _now;
    final first = now.add(fbScheduleMin);
    final last = now.add(fbScheduleMax);
    final start = _at ?? now.add(const Duration(hours: 1));
    final day = await showDatePicker(context: context, firstDate: DateTime(first.year, first.month, first.day), lastDate: last, initialDate: start.isBefore(first) ? first : start);
    if (day == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(start));
    if (t == null || !mounted) return;
    final at = DateTime(day.year, day.month, day.day, t.hour, t.minute);
    setState(() {
      if (at.isBefore(first)) {
        _error = 'Facebook needs at least 10 minutes. Pick ${_when(first.toIso8601String())} or later.';
      } else if (at.isAfter(last)) {
        _error = 'Facebook schedules up to 30 days ahead.';
      } else {
        _error = null;
        _at = at;
      }
    });
  }

  String? _localProblem() {
    final msg = _msg.text.trim();
    if (_kind == 'text' && msg.isEmpty) return 'Write the post text first.';
    if (msg.length > fbMessageMax) return 'Keep the post under $fbMessageMax characters.';
    if (_kind == 'link' && !RegExp(r'^https?://\S+\.\S+').hasMatch(_link.text.trim())) return 'Add a link that starts with https://.';
    if ((_kind == 'photo' || _kind == 'video') && _fileId == null) return _kind == 'photo' ? 'Choose a photo.' : 'Choose a video.';
    return null;
  }

  Future<void> _review() async {
    final problem = _localProblem();
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final api = ref.read(apiProvider);
    final draft = _draft;
    try {
      final pv = _m(await api.post('/facebook/posts/preview', draft));
      if (!mounted) return;
      final approved = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (ctx) => FacebookReviewSheet(preview: _m(pv['preview']), scheduled: _at != null),
      );
      if (approved != true || !mounted) return;
      final r = _m(await api.post('/facebook/posts', {...draft, 'confirm': true, 'contentHash': pv['contentHash'], 'requestKey': _requestKey()}));
      final post = _m(r['post']);
      ref.read(refreshTick.notifier).bump();
      if (!mounted) return;
      toast(context, post['status'] == 'scheduled' ? 'Scheduled on ${widget.page['name']}' : post['status'] == 'processing' ? 'Uploaded. Facebook is processing the video.' : 'Posted on ${widget.page['name']}');
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
      ref.read(refreshTick.notifier).bump(); // a failed post is still listed
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final media = _kind == 'photo' || _kind == 'video';
    return Page2(
      title: 'New post',
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
        Text('On ${widget.page['name']}', style: qs(14, c: q.text2)),
        const SizedBox(height: 12),
        SegmentedButton<String>(
          segments: [
            const ButtonSegment(value: 'text', label: Text('Text'), icon: Icon(Icons.notes)),
            const ButtonSegment(value: 'link', label: Text('Link'), icon: Icon(Icons.link)),
            const ButtonSegment(value: 'photo', label: Text('Photo'), icon: Icon(Icons.image_outlined)),
            ButtonSegment(value: 'video', label: const Text('Video'), icon: const Icon(Icons.movie_outlined), enabled: widget.canPostVideo),
          ],
          selected: {_kind},
          showSelectedIcon: false,
          onSelectionChanged: _busy
              ? null
              : (s) => setState(() {
                    _kind = s.first;
                    _media = null;
                    _fileId = null;
                    _error = null;
                  }),
        ),
        if (!widget.canPostVideo) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Video needs the "publish video" permission. Reconnect Facebook and allow it to post videos.', style: qs(12, c: q.text3))),
        const SizedBox(height: 16),
        TextField(
          key: const Key('fb-message'),
          controller: _msg,
          minLines: 4,
          maxLines: 10,
          maxLength: fbMessageMax,
          enabled: !_busy,
          decoration: InputDecoration(labelText: _kind == 'text' ? 'Post text' : 'Text (optional)', alignLabelWithHint: true),
          onChanged: (_) => setState(() {}),
        ),
        if (_kind == 'link') TextField(key: const Key('fb-link'), controller: _link, enabled: !_busy, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'Link (https://…)')),
        if (_kind == 'video') TextField(controller: _title, enabled: !_busy, maxLength: 200, decoration: const InputDecoration(labelText: 'Video title (optional)')),
        if (media) ...[
          const SizedBox(height: 12),
          QCard(
            child: Row(children: [
              Icon(_kind == 'video' ? Icons.movie_outlined : Icons.image_outlined, color: _media == null ? q.text3 : q.halo),
              const SizedBox(width: 12),
              Expanded(child: Text(_media == null ? (_kind == 'video' ? 'MP4 or MOV, up to 10 MB' : 'JPEG, PNG or GIF, up to 10 MB') : '${_media!.name} · ${(_media!.bytes.length / 1024 / 1024).toStringAsFixed(1)} MB', style: qs(14, c: q.text))),
              QButton(_media == null ? 'Choose' : 'Change', busy: _busy && _media == null, onPressed: _busy ? null : _pick),
            ]),
          ),
        ],
        const SizedBox(height: 12),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('Schedule for later', style: qs(15, c: q.text)),
          subtitle: Text(_at == null ? 'Off: posts right after you approve' : 'Goes live ${_when(_at!.toIso8601String())}', style: qs(13, c: q.text2)),
          value: _at != null,
          onChanged: _busy
              ? null
              : (v) async {
                  if (v) {
                    await _pickTime();
                  } else {
                    setState(() => _at = null);
                  }
                },
        ),
        if (_at != null) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _busy ? null : _pickTime, child: const Text('Change time'))),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Semantics(liveRegion: true, child: Text(_error!, style: qs(14, c: q.bad)))),
        const SizedBox(height: 16),
        QButton('Review post', key: const Key('fb-review'), kind: QBtn.halo, icon: Icons.visibility_outlined, expand: true, busy: _busy && (_media != null || !media), onPressed: _busy ? null : _review),
        const SizedBox(height: 8),
        Text('You\'ll see exactly what will be posted before anything goes to Facebook.', textAlign: TextAlign.center, style: qs(12, c: q.text3)),
      ]),
    );
  }
}

/// The approval step: the exact post, then an explicit Publish / Schedule.
class FacebookReviewSheet extends StatelessWidget {
  const FacebookReviewSheet({super.key, required this.preview, required this.scheduled});
  final Map<String, dynamic> preview;
  final bool scheduled;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final lines = (preview['lines'] as List? ?? const []).map((e) => '$e').toList();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${preview['title'] ?? 'Review post'}', style: qs(18, w: FontWeight.w600, c: q.text)),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .5),
            child: SingleChildScrollView(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (final l in lines) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(l, style: qs(14, c: l.startsWith('Text:') ? q.text : q.text2, h: 1.4))),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(child: QButton('Edit', kind: QBtn.ghost, onPressed: () => Navigator.pop(context, false))),
            const SizedBox(width: 12),
            Expanded(child: QButton(scheduled ? 'Approve and schedule' : 'Approve and publish', key: const Key('fb-approve'), kind: QBtn.halo, onPressed: () => Navigator.pop(context, true))),
          ]),
        ]),
      ),
    );
  }
}
