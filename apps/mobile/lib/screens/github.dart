import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../ui/theme.dart';
import '../ui/widgets.dart';

/// v1.10 (docs/24): read-only GitHub browser. Repositories, code, branches, commits, pull requests and CI runs where
/// the Qline GitHub App is installed. Nothing here changes GitHub: changes are made by the AI in chat, and each one
/// waits in Approvals with its diff.

Map<String, dynamic> _m(dynamic v) => (v as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
String _enc(String repo) => repo.split('/').map(Uri.encodeComponent).join('/');

Future<void> _openUrl(BuildContext context, String? url) async {
  if (url == null) return;
  final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) toast(context, 'Could not open GitHub.');
}

/// Colour for a CI conclusion / state.
Color _stateColor(QColors q, String? s) => switch (s) {
      'success' || 'passing' || 'merged' => q.ok,
      'failure' || 'failing' || 'timed_out' || 'cancelled' || 'action_required' => q.bad,
      'in_progress' || 'queued' || 'pending' || 'waiting' => q.warn,
      _ => q.text2,
    };

class _Dot extends StatelessWidget {
  const _Dot(this.color, {this.label});
  final Color color;
  final String? label;
  @override
  Widget build(BuildContext context) => Semantics(
        label: label,
        child: Container(width: 10, height: 10, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
      );
}

class _Chip extends StatelessWidget {
  const _Chip(this.text, {this.color});
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final c = color ?? q.text2;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(color: c.withValues(alpha: .1), borderRadius: BorderRadius.circular(6), border: Border.all(color: c.withValues(alpha: .35))),
      child: Text(text, style: qs(11, w: FontWeight.w600, c: c)),
    );
  }
}

/// A unified diff, line by line: additions and removals tinted, hunk headers dimmed. Scrolls sideways for long lines.
class DiffView extends StatelessWidget {
  const DiffView(this.diff, {super.key, this.maxLines});
  final String diff;
  final int? maxLines;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    var lines = diff.split('\n');
    final cut = maxLines != null && lines.length > maxLines!;
    if (cut) lines = lines.sublist(0, maxLines);
    Widget row(String l) {
      final head = l.startsWith('+++') || l.startsWith('---');
      final (Color? bg, Color fg) = head
          ? (null, q.text2)
          : l.startsWith('@@')
              ? (q.info.withValues(alpha: .08), q.info)
              : l.startsWith('+')
                  ? (q.ok.withValues(alpha: .12), q.text)
                  : l.startsWith('-')
                      ? (q.bad.withValues(alpha: .12), q.text)
                      : (null, q.text2);
      return Container(
        color: bg,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
        child: Text(l.isEmpty ? ' ' : l, softWrap: false, style: qs(12, c: fg, family: mono, w: head ? FontWeight.w600 : FontWeight.w400)),
      );
    }

    return Container(
      decoration: BoxDecoration(color: q.surface2, borderRadius: BorderRadius.circular(12), border: Border.all(color: q.line)),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        LayoutBuilder(
          builder: (context, box) => SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: box.maxWidth),
              child: IntrinsicWidth(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [for (final l in lines) row(l)])),
            ),
          ),
        ),
        if (cut) Padding(padding: const EdgeInsets.fromLTRB(8, 0, 8, 8), child: Text('… ${diff.split('\n').length - maxLines!} more lines', style: qs(12, c: q.text3))),
      ]),
    );
  }
}

class _Mono extends StatelessWidget {
  const _Mono(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: q.surface2, borderRadius: BorderRadius.circular(12), border: Border.all(color: q.line)),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.all(10),
        child: SelectableText(text, style: qs(12, c: q.text, family: mono, h: 1.45)),
      ),
    );
  }
}

/// Entry point (Integrations → GitHub → Code, pull requests and CI).
class GithubScreen extends StatelessWidget {
  const GithubScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'GitHub',
      body: Load<(Map<String, dynamic>, Map<String, dynamic>)>(
        fetch: (api) async => (_m(await api.get('/github/capabilities')), _m(await api.get('/github/repos'))),
        builder: (context, d, reload) {
          final (cap, repos) = d;
          final caps = items(cap, 'capabilities');
          final list = items(repos, 'repos');
          final risky = items(cap, 'installations').expand((i) => ((i['unusedRisky'] as List?) ?? const []).map((p) => '$p (${i['account']})')).toList();
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
              QCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [Icon(Icons.verified_user_outlined, color: q.halo, size: 20), const SizedBox(width: 8), Expanded(child: Text('How Qline uses GitHub', style: qs(15, w: FontWeight.w600, c: q.text)))]),
                  const SizedBox(height: 8),
                  for (final g in (cap['guarantees'] as List? ?? const []))
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Padding(padding: const EdgeInsets.only(top: 2), child: Icon(Icons.check, size: 16, color: q.ok)), const SizedBox(width: 8), Expanded(child: Text('$g', style: qs(13, c: q.text2, h: 1.4)))]),
                    ),
                ]),
              ),
              const SectionLabel('What the Qline app may do'),
              QCard(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Column(children: [
                  for (final c in caps)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 7),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Icon(c['granted'] == true ? Icons.check_circle : Icons.remove_circle_outline, size: 18, color: c['granted'] == true ? q.ok : q.text3, semanticLabel: c['granted'] == true ? 'Allowed' : 'Not allowed'),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('${c['name']}', style: qs(14, c: c['granted'] == true ? q.text : q.text2)),
                            if (c['granted'] != true) Text('Needs the ${_permLabel('${c['permission']}')} permission on the Qline GitHub App', style: qs(12, c: q.text3, h: 1.35)),
                          ]),
                        ),
                      ]),
                    ),
                ]),
              ),
              if (risky.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: QCard(
                    accent: q.warn.withValues(alpha: .5),
                    child: Text('The app also has permissions Qline never uses: ${risky.join(', ')}. You can remove them in the app\'s settings on GitHub.', style: qs(13, c: q.text2, h: 1.4)),
                  ),
                ),
              SectionLabel('Repositories (${list.length})'),
              if (repos['installed'] != true)
                const EmptyState(icon: Icons.code_off, title: 'The Qline app is not installed yet', body: 'Install the Qline GitHub App on the repositories you want the AI to use, then pull to refresh.')
              else if (list.isEmpty)
                const EmptyState(icon: Icons.folder_off_outlined, title: 'No repositories', body: 'The app is installed but no repositories were selected for it.')
              else
                for (final (i, r) in list.indexed)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Reveal(
                      index: i,
                      child: QCard(
                        onTap: () => push(context, RepoScreen(repo: r)),
                        child: Row(children: [
                          Icon(r['private'] == true ? Icons.lock_outline : Icons.public, size: 18, color: q.text2, semanticLabel: r['private'] == true ? 'Private' : 'Public'),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text('${r['fullName']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
                              if ((r['description'] as String? ?? '').isNotEmpty) Text('${r['description']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2, h: 1.35)),
                              const SizedBox(height: 4),
                              Wrap(spacing: 6, runSpacing: 4, children: [
                                if (r['language'] != null) _Chip('${r['language']}'),
                                if (r['defaultBranch'] != null) _Chip('${r['defaultBranch']}'),
                                if (r['archived'] == true) _Chip('Archived', color: q.warn),
                                if (r['pushedAt'] != null) Text('Updated ${ago(r['pushedAt'] as String?)}', style: qs(12, c: q.text3)),
                              ]),
                            ]),
                          ),
                          Icon(Icons.chevron_right, color: q.text3),
                        ]),
                      ),
                    ),
                  ),
            ]),
          );
        },
      ),
    );
  }
}

String _permLabel(String p) {
  final parts = p.split(':');
  final name = switch (parts.first) { 'contents' => 'Contents', 'pull_requests' => 'Pull requests', 'actions' => 'Actions', 'checks' => 'Checks', 'statuses' => 'Commit statuses', 'issues' => 'Issues', _ => parts.first };
  return '$name (${parts.length > 1 && parts[1] == 'write' ? 'read and write' : 'read'})';
}

/// One repository: code, branches, commits, pull requests and CI.
class RepoScreen extends StatelessWidget {
  const RepoScreen({super.key, required this.repo});
  final Map<String, dynamic> repo;
  String get _name => repo['fullName'] as String;
  @override
  Widget build(BuildContext context) {
    final base = '/github/repos/${_enc(_name)}';
    return DefaultTabController(
      length: 5,
      child: Scaffold(
        appBar: AppBar(
          title: Text(_name.split('/').last),
          actions: [IconButton(tooltip: 'Open on GitHub', icon: const Icon(Icons.open_in_new), onPressed: () => _openUrl(context, repo['url'] as String?))],
          bottom: const TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [Tab(text: 'Code'), Tab(text: 'Branches'), Tab(text: 'Commits'), Tab(text: 'Pull requests'), Tab(text: 'CI')]),
        ),
        body: SafeArea(
          top: false,
          child: TabBarView(children: [
            _CodeTab(repo: _name, base: base),
            _BranchesTab(base: base),
            _CommitsTab(repo: _name, base: base),
            _PullsTab(repo: _name, base: base),
            _RunsTab(repo: _name, base: base),
          ]),
        ),
      ),
    );
  }
}

class _CodeTab extends StatefulWidget {
  const _CodeTab({required this.repo, required this.base});
  final String repo, base;
  @override
  State<_CodeTab> createState() => _CodeTabState();
}

class _CodeTabState extends State<_CodeTab> with AutomaticKeepAliveClientMixin {
  String _path = '';
  @override
  bool get wantKeepAlive => true;
  @override
  Widget build(BuildContext context) {
    super.build(context);
    final q = context.q;
    final crumbs = _path.isEmpty ? <String>[] : _path.split('/');
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            TextButton.icon(onPressed: _path.isEmpty ? null : () => setState(() => _path = ''), icon: const Icon(Icons.home_outlined, size: 18), label: Text(widget.repo.split('/').last)),
            for (final (i, c) in crumbs.indexed) ...[
              Icon(Icons.chevron_right, size: 16, color: q.text3),
              TextButton(onPressed: i == crumbs.length - 1 ? null : () => setState(() => _path = crumbs.sublist(0, i + 1).join('/')), child: Text(c)),
            ],
          ]),
        ),
      ),
      Expanded(
        child: Load<Map>(
          key: ValueKey(_path),
          fetch: (api) async => await api.get('${widget.base}/tree', {if (_path.isNotEmpty) 'path': _path}) as Map,
          builder: (context, d, reload) {
            final entries = items(d, 'entries');
            if (entries.isEmpty) return const EmptyState(icon: Icons.folder_open, title: 'Empty folder', body: 'Nothing here.');
            return RefreshIndicator(
              onRefresh: reload,
              child: ListView.separated(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
                itemCount: entries.length,
                separatorBuilder: (_, _) => Divider(height: 1, color: q.line),
                itemBuilder: (context, i) {
                  final e = entries[i];
                  final dir = e['type'] == 'dir';
                  return ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                    leading: Icon(dir ? Icons.folder_outlined : Icons.description_outlined, color: dir ? q.halo : q.text2),
                    title: Text('${e['name']}', style: qs(14, c: q.text, family: dir ? ui : mono)),
                    trailing: dir ? Icon(Icons.chevron_right, color: q.text3) : Text(_size(e['size']), style: qs(12, c: q.text3)),
                    onTap: () => dir ? setState(() => _path = e['path'] as String) : push(context, FileScreen(repo: widget.repo, base: widget.base, path: e['path'] as String)),
                  );
                },
              ),
            );
          },
        ),
      ),
    ]);
  }
}

String _size(dynamic n) {
  final b = (n as num?)?.toInt() ?? 0;
  if (b < 1024) return '$b B';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
  return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
}

/// A text file with line numbers, in pages of 400 lines.
class FileScreen extends StatefulWidget {
  const FileScreen({super.key, required this.repo, required this.base, required this.path, this.ref});
  final String repo, base, path;
  final String? ref;
  @override
  State<FileScreen> createState() => _FileScreenState();
}

class _FileScreenState extends State<FileScreen> {
  int _page = 1;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: widget.path.split('/').last,
      body: Load<Map>(
        key: ValueKey(_page),
        fetch: (api) async => await api.get('${widget.base}/file', {'path': widget.path, 'page': '$_page', if (widget.ref != null) 'ref': widget.ref}) as Map,
        builder: (context, f, reload) {
          final text = f['text'] as String? ?? '';
          final first = (f['firstLine'] as num?)?.toInt() ?? 1;
          final lines = text.isEmpty ? <String>[] : text.split('\n');
          final pages = (f['pages'] as num?)?.toInt() ?? 1;
          final width = '${first + lines.length}'.length;
          return ListView(padding: const EdgeInsets.fromLTRB(12, 8, 12, 24), children: [
            Row(children: [
              Expanded(child: Text(widget.path, style: qs(13, c: q.text2, family: mono), maxLines: 2, overflow: TextOverflow.ellipsis)),
              IconButton(tooltip: 'Copy', icon: const Icon(Icons.copy_outlined, size: 20), onPressed: text.isEmpty ? null : () => Clipboard.setData(ClipboardData(text: text)).then((_) => context.mounted ? toast(context, 'Copied') : null)),
              IconButton(tooltip: 'Open on GitHub', icon: const Icon(Icons.open_in_new, size: 20), onPressed: () => _openUrl(context, f['url'] as String?)),
            ]),
            Text('${_size(f['size'])} · ${f['lines'] ?? 0} lines${pages > 1 ? ' · page $_page of $pages' : ''}', style: qs(12, c: q.text3)),
            if (f['note'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: QCard(accent: q.warn.withValues(alpha: .5), padding: const EdgeInsets.all(12), child: Text('${f['note']}', style: qs(13, c: q.text2, h: 1.4)))),
            const SizedBox(height: 8),
            if (lines.isNotEmpty)
              Container(
                decoration: BoxDecoration(color: q.surface2, borderRadius: BorderRadius.circular(12), border: Border.all(color: q.line)),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    for (final (i, l) in lines.indexed)
                      Row(children: [
                        Container(width: 10.0 + width * 8, padding: const EdgeInsets.only(right: 8), alignment: Alignment.centerRight, child: Text('${first + i}', style: qs(12, c: q.text3, family: mono))),
                        Padding(padding: const EdgeInsets.only(right: 12), child: Text(l.isEmpty ? ' ' : l, softWrap: false, style: qs(12, c: q.text, family: mono, h: 1.45))),
                      ]),
                  ]),
                ),
              ),
            if (pages > 1)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Row(children: [
                  Expanded(child: QButton('Previous', icon: Icons.chevron_left, onPressed: _page > 1 ? () => setState(() => _page--) : null)),
                  const SizedBox(width: 12),
                  Expanded(child: QButton('Next', icon: Icons.chevron_right, onPressed: _page < pages ? () => setState(() => _page++) : null)),
                ]),
              ),
          ]);
        },
      ),
    );
  }
}

class _BranchesTab extends StatelessWidget {
  const _BranchesTab({required this.base});
  final String base;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Load<Map>(
      fetch: (api) async => await api.get('$base/branches') as Map,
      builder: (context, d, reload) {
        final list = items(d, 'branches');
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
            Text('The AI only commits to working branches: never the default branch or a protected one.', style: qs(13, c: q.text2, h: 1.4)),
            const SizedBox(height: 10),
            for (final b in list)
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                leading: Icon(Icons.call_split, color: q.text2),
                title: Text('${b['name']}', style: qs(14, c: q.text, family: mono)),
                subtitle: Text('${b['sha']}'.substring(0, 7), style: qs(12, c: q.text3, family: mono)),
                trailing: Wrap(spacing: 6, children: [
                  if (b['default'] == true) _Chip('Default', color: q.info),
                  if (b['protected'] == true) _Chip('Protected', color: q.warn),
                ]),
              ),
          ]),
        );
      },
    );
  }
}

class _CommitsTab extends StatelessWidget {
  const _CommitsTab({required this.repo, required this.base});
  final String repo, base;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Load<Map>(
      fetch: (api) async => await api.get('$base/commits') as Map,
      builder: (context, d, reload) {
        final list = items(d, 'commits');
        if (list.isEmpty) return const EmptyState(icon: Icons.commit, title: 'No commits', body: 'This branch has no commits yet.');
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
            itemCount: list.length,
            separatorBuilder: (_, _) => Divider(height: 1, color: q.line),
            itemBuilder: (context, i) {
              final c = list[i];
              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                title: Text('${c['message']}'.split('\n').first, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text)),
                subtitle: Text('${c['short']} · ${c['author'] ?? 'unknown'} · ${ago(c['date'] as String?)}', style: qs(12, c: q.text3)),
                trailing: Icon(Icons.chevron_right, color: q.text3),
                onTap: () => push(context, CommitScreen(base: base, sha: c['sha'] as String)),
              );
            },
          ),
        );
      },
    );
  }
}

class _FileChanges extends StatelessWidget {
  const _FileChanges(this.files);
  final List<Map<String, dynamic>> files;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final f in files) ...[
        Padding(
          padding: const EdgeInsets.only(top: 12, bottom: 6),
          child: Row(children: [
            Expanded(child: Text('${f['path']}', style: qs(13, w: FontWeight.w600, c: q.text, family: mono), maxLines: 2, overflow: TextOverflow.ellipsis)),
            Text('+${f['additions'] ?? 0}', style: qs(12, w: FontWeight.w600, c: q.ok)),
            const SizedBox(width: 6),
            Text('−${f['deletions'] ?? 0}', style: qs(12, w: FontWeight.w600, c: q.bad)),
          ]),
        ),
        if (f['patch'] != null) DiffView(f['patch'] as String, maxLines: 80) else Text('${cap('${f['status']}')} (no text diff)', style: qs(12, c: q.text3)),
      ],
    ]);
  }
}

class CommitScreen extends StatelessWidget {
  const CommitScreen({super.key, required this.base, required this.sha});
  final String base, sha;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Commit ${sha.substring(0, 7)}',
      body: Load<Map>(
        fetch: (api) async => await api.get('$base/commits/$sha') as Map,
        builder: (context, c, reload) => ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
          Text('${c['message']}', style: qs(15, c: q.text, h: 1.4)),
          const SizedBox(height: 6),
          Text('${c['author'] ?? 'unknown'} · ${ago(c['date'] as String?)}', style: qs(12, c: q.text3)),
          SectionLabel('Files (${items(c, 'files').length})'),
          _FileChanges(items(c, 'files')),
        ]),
      ),
    );
  }
}

class _PullsTab extends StatefulWidget {
  const _PullsTab({required this.repo, required this.base});
  final String repo, base;
  @override
  State<_PullsTab> createState() => _PullsTabState();
}

class _PullsTabState extends State<_PullsTab> {
  String _state = 'open';
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'open', label: Text('Open')), ButtonSegment(value: 'closed', label: Text('Closed')), ButtonSegment(value: 'all', label: Text('All'))],
          selected: {_state},
          showSelectedIcon: false,
          onSelectionChanged: (s) => setState(() => _state = s.first),
        ),
      ),
      Expanded(
        child: Load<Map>(
          key: ValueKey(_state),
          fetch: (api) async => await api.get('${widget.base}/pulls', {'state': _state}) as Map,
          builder: (context, d, reload) {
            final list = items(d, 'pulls');
            if (list.isEmpty) return EmptyState(icon: Icons.merge_type, title: 'No ${_state == 'all' ? '' : '$_state '}pull requests', body: 'Ask the AI to open one from a working branch. It waits for your approval.');
            return RefreshIndicator(
              onRefresh: reload,
              child: ListView.separated(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                itemCount: list.length,
                separatorBuilder: (_, _) => Divider(height: 1, color: q.line),
                itemBuilder: (context, i) {
                  final p = list[i];
                  return ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                    leading: Icon(Icons.merge_type, color: _stateColor(q, p['state'] == 'open' ? 'in_progress' : p['state'] as String?)),
                    title: Text('#${p['number']} ${p['title']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text)),
                    subtitle: Text('${p['head']} → ${p['base']}${p['draft'] == true ? ' · draft' : ''} · ${ago(p['updatedAt'] as String?)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(12, c: q.text3)),
                    trailing: Icon(Icons.chevron_right, color: q.text3),
                    onTap: () => push(context, PullScreen(base: widget.base, number: (p['number'] as num).toInt())),
                  );
                },
              ),
            );
          },
        ),
      ),
    ]);
  }
}

class PullScreen extends StatelessWidget {
  const PullScreen({super.key, required this.base, required this.number});
  final String base;
  final int number;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'Pull request #$number',
      body: Load<Map>(
        fetch: (api) async => await api.get('$base/pulls/$number') as Map,
        builder: (context, p, reload) {
          final checks = _m(p['checks']);
          final runs = items(checks, 'checkRuns');
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
              Text('${p['title']}', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                StatusPill('${p['state']}'),
                if (p['draft'] == true) _Chip('Draft'),
                Text('${p['head']} → ${p['base']}', style: qs(12, c: q.text2, family: mono)),
              ]),
              const SizedBox(height: 8),
              Text('+${p['additions'] ?? 0} −${p['deletions'] ?? 0} in ${p['changedFiles'] ?? 0} files · by ${p['author'] ?? 'unknown'}', style: qs(12, c: q.text3)),
              if ((p['body'] as String? ?? '').isNotEmpty) ...[const SectionLabel('Description'), Text('${p['body']}', style: qs(14, c: q.text2, h: 1.45))],
              SectionLabel('Checks · ${checks['overall'] ?? 'none'}'),
              if (runs.isEmpty) Text('No checks reported.', style: qs(13, c: q.text3)),
              for (final c in runs)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [_Dot(_stateColor(q, (c['conclusion'] ?? c['status']) as String?), label: '${c['conclusion'] ?? c['status']}'), const SizedBox(width: 10), Expanded(child: Text('${c['name']}', style: qs(14, c: q.text))), Text(cap('${c['conclusion'] ?? c['status']}'), style: qs(12, c: q.text3))]),
                ),
              if (items(p, 'reviews').isNotEmpty) ...[
                const SectionLabel('Reviews'),
                for (final r in items(p, 'reviews')) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('${r['author']}: ${cap('${r['state']}'.toLowerCase())}${(r['body'] as String? ?? '').isNotEmpty ? ' — ${r['body']}' : ''}', style: qs(13, c: q.text2, h: 1.4))),
              ],
              SectionLabel('Files (${items(p, 'files').length})'),
              _FileChanges(items(p, 'files')),
              const SizedBox(height: 16),
              Text('Qline never merges. Merge on GitHub when you are ready.', style: qs(12, c: q.text3)),
            ]),
          );
        },
      ),
    );
  }
}

class _RunsTab extends StatelessWidget {
  const _RunsTab({required this.repo, required this.base});
  final String repo, base;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Load<Map>(
      fetch: (api) async => await api.get('$base/runs') as Map,
      builder: (context, d, reload) {
        final list = items(d, 'runs');
        if (list.isEmpty) return const EmptyState(icon: Icons.play_circle_outline, title: 'No workflow runs', body: 'GitHub Actions has not run in this repository yet.');
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
            itemCount: list.length,
            separatorBuilder: (_, _) => Divider(height: 1, color: q.line),
            itemBuilder: (context, i) {
              final r = list[i];
              final s = (r['conclusion'] ?? r['status']) as String?;
              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                leading: Padding(padding: const EdgeInsets.only(top: 4), child: _Dot(_stateColor(q, s), label: s)),
                minLeadingWidth: 10,
                title: Text('${r['name']} · ${r['title']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(14, c: q.text)),
                subtitle: Text('${cap(s ?? '')} · ${r['branch']} · ${r['sha']} · ${ago(r['createdAt'] as String?)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(12, c: q.text3)),
                trailing: Icon(Icons.chevron_right, color: q.text3),
                onTap: () => push(context, RunScreen(base: base, id: (r['id'] as num).toInt())),
              );
            },
          ),
        );
      },
    );
  }
}

class RunScreen extends StatelessWidget {
  const RunScreen({super.key, required this.base, required this.id});
  final String base;
  final int id;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Page2(
      title: 'CI run',
      body: Load<Map>(
        fetch: (api) async => await api.get('$base/runs/$id') as Map,
        builder: (context, r, reload) {
          final s = (r['conclusion'] ?? r['status']) as String?;
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
              Row(children: [_Dot(_stateColor(q, s), label: s), const SizedBox(width: 8), Expanded(child: Text('${r['name']}', style: Theme.of(context).textTheme.titleLarge))]),
              const SizedBox(height: 6),
              Text('${cap(s ?? '')} · ${r['branch']} · ${r['sha']} · attempt ${r['attempt'] ?? 1}', style: qs(12, c: q.text3)),
              Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => _openUrl(context, r['url'] as String?), icon: const Icon(Icons.open_in_new, size: 18), label: const Text('Open on GitHub'))),
              for (final j in items(r, 'jobs')) ...[
                SectionLabel('${j['name']}', trailing: Text(cap('${j['conclusion'] ?? j['status']}'), style: qs(12, w: FontWeight.w600, c: _stateColor(q, (j['conclusion'] ?? j['status']) as String?)))),
                for (final st in items(j, 'steps'))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(children: [_Dot(_stateColor(q, (st['conclusion'] ?? st['status']) as String?), label: '${st['conclusion'] ?? st['status']}'), const SizedBox(width: 10), Expanded(child: Text('${st['name']}', style: qs(13, c: q.text2)))]),
                  ),
                if (j['logTail'] != null) ...[
                  Padding(padding: const EdgeInsets.only(top: 10, bottom: 6), child: Text('End of the log (secrets hidden)', style: qs(12, w: FontWeight.w600, c: q.text3))),
                  _Mono('${j['logTail']}'),
                ],
              ],
            ]),
          );
        },
      ),
    );
  }
}
