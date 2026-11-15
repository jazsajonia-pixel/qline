import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

String _show(dynamic v) {
  if (v == null) return '—';
  if (v is List) return v.isEmpty ? '—' : v.join(', ');
  if (v is Map) return const JsonEncoder.withIndent(' ').convert(v);
  return '$v';
}

class SetupScreen extends ConsumerStatefulWidget {
  const SetupScreen({super.key});
  @override
  ConsumerState<SetupScreen> createState() => _SetupState();
}

enum _Phase { loading, intro, questions, analysis, proposal, done, error }

class _SetupState extends ConsumerState<SetupScreen> {
  _Phase _phase = _Phase.loading;
  String? _error;
  Map<String, dynamic>? _session;
  List<Map<String, dynamic>> _questions = [];
  final Map<String, Map<String, dynamic>> _answers = {};
  int _i = 0;
  final _text = TextEditingController();
  Map<String, dynamic>? _analysis;
  String? _analysisNote, _analysisSource;
  Map<String, dynamic>? _proposal;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).get('/onboarding/current') as Map;
      _questions = items(r, 'questions');
      final s = r['session'] as Map?;
      if (s != null) {
        _session = s.cast<String, dynamic>();
        ((s['answers'] as Map?) ?? {}).forEach((k, v) => _answers['$k'] = (v as Map).cast<String, dynamic>());
      }
      setState(() => _phase = s?['state'] == 'active' ? _Phase.done : _Phase.intro);
    } catch (e) {
      setState(() {
        _phase = _Phase.error;
        _error = '$e';
      });
    }
  }

  Future<void> _start() async {
    setState(() => _busy = true);
    try {
      final r = await ref.read(apiProvider).post('/onboarding/sessions') as Map;
      _session = (r['session'] as Map).cast<String, dynamic>();
      if (_session!['state'] == 'active') _answers.clear();
      ((_session!['answers'] as Map?) ?? {}).forEach((k, v) => _answers['$k'] = (v as Map).cast<String, dynamic>());
      _i = 0;
      _syncText();
      setState(() => _phase = _Phase.questions);
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _syncText() => _text.text = (_answers[_questions[_i]['id']]?['unknown'] == true) ? '' : (_answers[_questions[_i]['id']]?['value'] as String? ?? '');

  Future<void> _next({bool unknown = false, String? choice}) async {
    final qn = _questions[_i];
    final v = choice ?? _text.text.trim();
    if (!unknown && v.isEmpty) return toast(context, 'Answer, or tap "I\'m not sure".');
    _answers[qn['id'] as String] = {'value': unknown ? '' : v, if (unknown) 'unknown': true};
    // Save as you go so nothing is lost.
    try {
      await ref.read(apiProvider).post('/onboarding/sessions/${_session!['id']}/answers', {'answers': {qn['id']: _answers[qn['id']]}});
    } catch (e) {
      if (mounted) toastError(context, e);
      return;
    }
    if (_i < _questions.length - 1) {
      setState(() => _i++);
      _syncText();
    } else {
      await _analyse();
    }
  }

  Future<void> _analyse() async {
    setState(() {
      _busy = true;
      _phase = _Phase.analysis;
      _analysis = null;
    });
    try {
      final r = await ref.read(apiProvider).post('/onboarding/sessions/${_session!['id']}/analysis') as Map;
      setState(() {
        _analysis = (r['analysis'] as Map).cast<String, dynamic>();
        _analysisNote = r['note'] as String?;
        _analysisSource = r['source'] as String?;
      });
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _propose() async {
    setState(() => _busy = true);
    try {
      final r = await ref.read(apiProvider).post('/onboarding/sessions/${_session!['id']}/proposal') as Map;
      setState(() {
        _proposal = r.cast<String, dynamic>();
        _phase = _Phase.proposal;
      });
    } catch (e) {
      if (mounted) toastError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _apply() async {
    setState(() => _busy = true);
    final r = await act(context, ref, (api) => api.post('/config/versions/${_proposal!['version']}/apply'), ok: 'Applied. You can roll back any time in Settings.');
    if (!mounted) return;
    setState(() => _busy = false);
    if (r != null) {
      await ref.read(sessionProvider.notifier).refresh().catchError((_) {});
      setState(() => _phase = _Phase.done);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canApply = ref.watch(sessionProvider.select((s) => s.canManage));
    return Page2(
      title: 'Business setup',
      body: switch (_phase) {
        _Phase.loading => const SkeletonList(rows: 3),
        _Phase.error => ErrorPanel(_error ?? 'Error', onRetry: _load),
        _Phase.intro => _intro(canApply),
        _Phase.questions => _question(),
        _Phase.analysis => _analysisView(),
        _Phase.proposal => _proposalView(canApply),
        _Phase.done => _done(canApply),
      },
    );
  }

  Widget _intro(bool canApply) {
    final q = context.q;
    final answered = _answers.length;
    return ListView(padding: const EdgeInsets.all(20), children: [
      Icon(Icons.auto_awesome_outlined, color: q.halo, size: 32),
      const SizedBox(height: 12),
      Text('Let\'s shape Qline around your business', style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 8),
      Text('${_questions.length} short questions about how you work. Qline turns your answers into a proposed setup — pipeline stages, task stages, which agents are active, and how cautious they are. Nothing changes until you review and apply it.', style: qs(15, c: q.text2, h: 1.5)),
      if (answered > 0) Padding(padding: const EdgeInsets.only(top: 12), child: Text('You\'ve answered $answered so far. Pick up where you left off.', style: qs(14, c: q.text))),
      const SizedBox(height: 24),
      if (!canApply)
        QCard(child: Text('Only an owner or admin can run setup.', style: qs(14, c: q.text2)))
      else
        QButton(answered > 0 ? 'Continue' : 'Start', kind: QBtn.secondary, expand: true, busy: _busy, onPressed: _start),
    ]);
  }

  Widget _question() {
    final q = context.q;
    final qn = _questions[_i];
    final options = (qn['options'] as List?)?.cast<String>();
    final current = _answers[qn['id']]?['value'] as String?;
    return Column(children: [
      LinearProgressIndicator(value: (_i + 1) / _questions.length, minHeight: 3),
      Expanded(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          Text('Question ${_i + 1} of ${_questions.length}', style: qs(12, w: FontWeight.w600, c: q.text3, ls: .6)),
          const SizedBox(height: 10),
          Text(qn['text'] as String, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 20),
          if (options != null)
            for (final o in options)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: QCard(
                  accent: current == o ? q.halo : null,
                  onTap: () => _next(choice: o),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  child: Row(children: [Expanded(child: Text(o, style: qs(15, c: q.text))), if (current == o) Icon(Icons.check, color: q.halo, size: 18)]),
                ),
              )
          else
            TextField(controller: _text, autofocus: true, minLines: 2, maxLines: 6, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(hintText: 'Type your answer')),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Row(children: [
          if (_i > 0)
            QButton('Back', kind: QBtn.ghost, icon: Icons.arrow_back, onPressed: () {
              setState(() => _i--);
              _syncText();
            }),
          const Spacer(),
          QButton('I\'m not sure', kind: QBtn.ghost, onPressed: () => _next(unknown: true)),
          if (options == null) ...[const SizedBox(width: 8), QButton(_i == _questions.length - 1 ? 'Finish' : 'Next', onPressed: () => _next())],
        ]),
      ),
    ]);
  }

  Widget _analysisView() {
    final q = context.q;
    if (_analysis == null) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [const CircularProgressIndicator(), const SizedBox(height: 12), Text('Reading your answers…', style: qs(14, c: q.text2))]));
    }
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Here\'s what we understood', style: Theme.of(context).textTheme.headlineSmall),
      if (_analysisNote != null)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(Icons.info_outline, size: 16, color: _analysisSource == 'ai' ? q.info : q.warn), const SizedBox(width: 6), Expanded(child: Text(_analysisNote!, style: qs(13, c: q.text2)))]),
        ),
      const SizedBox(height: 12),
      for (final e in _analysis!.entries)
        if (e.value is Map)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: QCard(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(cap(e.key.replaceAllMapped(RegExp('[A-Z]'), (m) => ' ${m[0]!.toLowerCase()}')), style: qs(13, w: FontWeight.w600, c: q.text2))),
                  SourceTag((e.value as Map)['source'] == 'answer' ? 'user' : (e.value as Map)['source'] as String?),
                ]),
                const SizedBox(height: 4),
                Text(_show((e.value as Map)['value']), style: qs(15, c: q.text)),
                if (((e.value as Map)['confidence'] as num? ?? 1) < .6) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Low confidence — check this', style: qs(12, c: q.warn))),
              ]),
            ),
          ),
      const SizedBox(height: 8),
      Row(children: [
        QButton('Edit answers', kind: QBtn.ghost, onPressed: () {
          setState(() {
            _i = 0;
            _phase = _Phase.questions;
          });
          _syncText();
        }),
        const Spacer(),
        QButton('See proposed changes', busy: _busy, onPressed: _propose),
      ]),
    ]);
  }

  Widget _proposalView(bool canApply) {
    final q = context.q;
    final diff = items(_proposal!['diff']);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Proposed setup · v${_proposal!['version']}', style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 6),
      Text('${diff.length} changes. Nothing is applied until you tap Apply, and you can roll back later.', style: qs(14, c: q.text2)),
      const SizedBox(height: 12),
      if (diff.isEmpty) QCard(child: Text('No changes from your current setup.', style: qs(14, c: q.text2))),
      for (final d in diff)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: QCard(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Expanded(child: Text('${d['path']}', style: qs(12, w: FontWeight.w600, c: q.text2, family: mono))), SourceTag(d['source'] == 'answer' ? 'user' : d['source'] as String?)]),
              const SizedBox(height: 6),
              Text(_show(d['from']), style: qs(13, c: q.text3).copyWith(decoration: TextDecoration.lineThrough)),
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(Icons.arrow_forward, size: 14, color: q.ok), const SizedBox(width: 4), Expanded(child: Text(_show(d['to']), style: qs(14, c: q.text)))]),
            ]),
          ),
        ),
      const SizedBox(height: 12),
      if (canApply) QButton('Apply setup', kind: QBtn.halo, icon: Icons.check, expand: true, busy: _busy, onPressed: _apply),
    ]);
  }

  Widget _done(bool canApply) {
    final q = context.q;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Row(children: [Icon(Icons.check_circle_outline, color: q.ok), const SizedBox(width: 8), Text('Setup applied', style: qs(18, w: FontWeight.w600, c: q.text))]),
      const SizedBox(height: 6),
      Text('Run the interview again when your business changes. Each run creates a new version you can review.', style: qs(14, c: q.text2)),
      const SizedBox(height: 12),
      if (canApply)
        QButton('Run setup again', onPressed: () {
          _answers.clear();
          _start();
        }),
      const SectionLabel('Configuration history'),
      const ConfigHistory(),
    ]);
  }
}

class ConfigHistory extends ConsumerWidget {
  const ConfigHistory({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final canApply = ref.watch(sessionProvider.select((s) => s.canManage));
    return Load<Map>(
      skeleton: const SizedBox(height: 80),
      fetch: (api) async => await api.get('/config/versions') as Map,
      builder: (context, r, _) {
        final list = items(r);
        final current = (r['current'] as Map?)?['config_version'];
        if (list.isEmpty) return Text('No versions yet.', style: qs(14, c: q.text3));
        return Column(children: [
          for (final v in list)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('Version ${v['version']}${v['version'] == current ? ' · current' : ''}', style: qs(14, w: FontWeight.w600, c: q.text)),
              subtitle: Text('${(v['diff'] as List?)?.length ?? 0} changes · ${ago(v['created_at'] as String?)}'),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                StatusPill(v['status'] as String),
                if (canApply && v['version'] != current && (v['status'] == 'applied' || v['status'] == 'superseded'))
                  IconButton(
                    tooltip: 'Roll back to this version',
                    icon: const Icon(Icons.restore),
                    onPressed: () async {
                      if (await confirm(context, title: 'Roll back to v${v['version']}?', body: 'Your workspace settings return to how they were in this version. A new entry is recorded in the audit log.', action: 'Roll back', destructive: true)) {
                        if (context.mounted) await act(context, ref, (api) => api.post('/config/versions/${v['version']}/rollback'), ok: 'Rolled back');
                      }
                    },
                  ),
                if (canApply && v['status'] == 'proposed')
                  IconButton(
                    tooltip: 'Apply this version',
                    icon: const Icon(Icons.check),
                    onPressed: () async {
                      if (await confirm(context, title: 'Apply v${v['version']}?', body: 'This changes your workspace setup.', action: 'Apply')) {
                        if (context.mounted) await act(context, ref, (api) => api.post('/config/versions/${v['version']}/apply'), ok: 'Applied');
                      }
                    },
                  ),
              ]),
            ),
        ]);
      },
    );
  }
}
