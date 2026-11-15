import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:material_ui/material_ui.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/core_painter.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'approvals.dart';

class _Step {
  _Step(this.id, this.tool, this.summary, this.decision);
  final String? id;
  final String tool;
  String summary;
  final String decision;
  bool? ok;
}

class _Msg {
  _Msg(this.role, this.text, {this.steps, this.error});
  final String role;
  String text;
  List<_Step>? steps;
  Map<String, dynamic>? approval;
  String? error;
}

/// Live AI is always dark (docs/03 §5): the energy core needs a dark field.
class LiveScreen extends ConsumerWidget {
  const LiveScreen({super.key, this.conversationId});
  final String? conversationId;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Theme(data: buildTheme(false), child: _Live(conversationId: conversationId));
}

class _Live extends ConsumerStatefulWidget {
  const _Live({this.conversationId});
  final String? conversationId;
  @override
  ConsumerState<_Live> createState() => _LiveState();
}

class _LiveState extends ConsumerState<_Live> {
  CoreState _core = CoreState.idle;
  List<Map<String, dynamic>> _agents = [];
  Map<String, dynamic>? _agent;
  String? _convId;
  final List<_Msg> _msgs = [];
  Map<String, dynamic>? _ai;
  String? _runId;
  StreamSubscription<SseEvent>? _sub;
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _stt = SpeechToText();
  bool _sttReady = false, _listening = false;
  double _level = 0;
  final _tts = FlutterTts();
  bool _loading = true;
  String? _loadError;

  Api get _api => ref.read(apiProvider);

  @override
  void initState() {
    super.initState();
    _convId = widget.conversationId;
    _init();
    _tts.setCompletionHandler(() {
      if (mounted && _core == CoreState.speaking) setState(() => _core = CoreState.idle);
    });
  }

  Future<void> _init() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final results = await Future.wait([_api.get('/agents'), _api.get('/ai/status').catchError((_) => <String, dynamic>{'status': 'unavailable', 'detail': 'Could not check AI status.'})]);
      _agents = items(results[0]);
      _ai = (results[1] as Map).cast<String, dynamic>();
      _agent = _agents.where((a) => a['template'] == 'ceo').firstOrNull ?? _agents.firstOrNull;
      if (_convId != null) await _loadConversation(_convId!);
      if (_ai?['status'] != 'available') _core = CoreState.error;
    } on ApiException catch (e) {
      _loadError = e.message;
      _core = e.isNetwork ? CoreState.offline : CoreState.error;
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _loadConversation(String id) async {
    final c = await _api.get('/conversations/$id') as Map;
    _convId = id;
    _agent = _agents.where((a) => a['id'] == c['agent_id']).firstOrNull ?? _agent;
    _msgs
      ..clear()
      ..addAll(items(c, 'messages').map((m) => _Msg(m['role'] as String, m['content'] as String)));
    if (mounted) setState(() {});
    _toBottom();
  }

  void _toBottom() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      });

  Future<void> _send([String? text]) async {
    final content = (text ?? _input.text).trim();
    if (content.isEmpty || _runId != null) return;
    _input.clear();
    await _tts.stop();
    setState(() {
      _msgs.add(_Msg('user', content));
      _core = CoreState.thinking;
    });
    _toBottom();
    try {
      _convId ??= ((await _api.post('/conversations', {if (_agent != null) 'agentId': _agent!['id']})) as Map)['id'] as String;
      final r = await _api.post('/conversations/$_convId/messages', {'content': content}) as Map;
      _runId = r['runId'] as String;
      _stream(_runId!);
    } on ApiException catch (e) {
      setState(() {
        _msgs.add(_Msg('system_notice', '', error: e.message));
        _core = e.isNetwork ? CoreState.offline : CoreState.error;
      });
    }
  }

  void _stream(String runId, {String? lastId}) {
    final reply = _Msg('assistant', '', steps: []);
    setState(() => _msgs.add(reply));
    String? last = lastId;
    _sub = _api.sse('/runs/$runId/stream', lastEventId: lastId).listen(
      (e) {
        last = e.id ?? last;
        final d = e.data;
        setState(() {
          switch (e.event) {
            case 'status':
              _core = d['state'] == 'thinking' ? CoreState.thinking : _core;
            case 'token':
              reply.text += d['text'] as String? ?? '';
              _core = CoreState.speaking;
            case 'tool.planned':
              reply.steps!.add(_Step(d['stepId'] as String?, d['tool'] as String? ?? 'tool', d['summary'] as String? ?? '', d['decision'] as String? ?? 'allow'));
              _core = CoreState.tool;
            case 'tool.result':
              final s = reply.steps!.where((s) => s.id == d['stepId']).lastOrNull ?? reply.steps!.lastOrNull;
              if (s != null) {
                s.ok = d['ok'] as bool?;
                if (d['summary'] != null) s.summary = d['summary'] as String;
              }
              _core = CoreState.thinking;
            case 'approval.required':
              reply.approval = d;
              _core = CoreState.approval;
            case 'error':
              reply.error = d['message'] as String? ?? 'Something went wrong.';
              _core = CoreState.error;
            case 'done':
              if (_core != CoreState.approval && _core != CoreState.error) _core = d['status'] == 'waiting_approval' ? CoreState.approval : CoreState.success;
          }
        });
        _toBottom();
      },
      onError: (Object err) {
        setState(() {
          reply.error = err is ApiException ? err.message : 'The connection dropped. The answer is still saved; reopen this conversation to see it.';
          _core = err is ApiException && !err.isNetwork ? CoreState.error : CoreState.offline;
          _runId = null;
        });
      },
      onDone: () async {
        _runId = null;
        ref.read(refreshTick.notifier).bump();
        if (!mounted) return;
        if (reply.text.isEmpty && reply.error == null && reply.approval == null && (reply.steps?.isEmpty ?? true)) {
          setState(() => reply.error = 'No answer came back. Try again.');
        }
        if (_core == CoreState.success) {
          if (ref.read(prefsProvider).speak && reply.text.isNotEmpty) {
            setState(() => _core = CoreState.speaking);
            await _tts.speak(reply.text);
          } else {
            await Future<void>.delayed(const Duration(milliseconds: 900));
            if (mounted && _core == CoreState.success) setState(() => _core = CoreState.idle);
          }
        } else if (_core == CoreState.speaking || _core == CoreState.thinking) {
          setState(() => _core = CoreState.idle);
        }
        setState(() {});
      },
    );
  }

  Future<void> _cancel() async {
    final id = _runId;
    if (id == null) return;
    await _sub?.cancel();
    try {
      await _api.post('/runs/$id/cancel');
    } catch (_) {}
    setState(() {
      _runId = null;
      _core = CoreState.idle;
      _msgs.add(_Msg('system_notice', 'Stopped.'));
    });
  }

  Future<void> _toggleMic() async {
    if (_listening) {
      await _stt.stop();
      return;
    }
    if (!_sttReady) {
      _sttReady = await _stt.initialize(
        onStatus: (s) {
          if (s == 'done' || s == 'notListening') {
            if (mounted) {
              setState(() {
                _listening = false;
                if (_core == CoreState.listening) _core = CoreState.idle;
              });
            }
          }
        },
        onError: (e) {
          if (mounted) {
            setState(() {
              _listening = false;
              _core = CoreState.idle;
            });
            toast(context, e.errorMsg == 'error_no_match' ? 'Didn\'t catch that. Try again.' : 'Voice input stopped: ${e.errorMsg.replaceAll('_', ' ')}');
          }
        },
      );
      if (!_sttReady) {
        if (mounted) toast(context, 'Voice input is unavailable. Allow microphone access or install a speech service.');
        return;
      }
    }
    await _tts.stop();
    setState(() {
      _listening = true;
      _core = CoreState.listening;
    });
    await _stt.listen(
      onResult: (SpeechRecognitionResult r) {
        setState(() => _input.text = r.recognizedWords);
        if (r.finalResult && r.recognizedWords.trim().isNotEmpty) _send(r.recognizedWords);
      },
      onSoundLevelChange: (l) => setState(() => _level = ((l + 2) / 12).clamp(0, 1).toDouble()),
      listenOptions: SpeechListenOptions(partialResults: true, cancelOnError: true, listenMode: ListenMode.dictation, pauseFor: const Duration(seconds: 3)),
    );
  }

  void _newChat() {
    _sub?.cancel();
    _tts.stop();
    setState(() {
      _convId = null;
      _runId = null;
      _msgs.clear();
      _core = _ai?['status'] == 'available' ? CoreState.idle : CoreState.error;
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _stt.cancel();
    _tts.stop();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final prefs = ref.watch(prefsProvider);
    final aiOk = _ai?['status'] == 'available';
    final hasChat = _msgs.isNotEmpty;
    final template = _agent?['template'] as String? ?? 'ceo';
    return Scaffold(
      backgroundColor: const Color(0xFF05070A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        leading: IconButton(tooltip: 'Close', icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
        title: _AgentPicker(agents: _agents, selected: _agent, onPick: _runId != null ? null : (a) => setState(() {
              _agent = a;
              _newChat();
            })),
        actions: [
          IconButton(tooltip: prefs.speak ? 'Spoken replies on' : 'Spoken replies off', icon: Icon(prefs.speak ? Icons.volume_up_outlined : Icons.volume_off_outlined), onPressed: () => ref.read(prefsProvider.notifier).set(speak: !prefs.speak)),
          IconButton(
            tooltip: 'Conversations',
            icon: const Icon(Icons.history),
            onPressed: () async {
              final id = await showModalBottomSheet<String>(context: context, builder: (_) => Theme(data: buildTheme(false), child: const _History()));
              if (id != null) {
                _sub?.cancel();
                try {
                  await _loadConversation(id);
                  setState(() => _core = aiOk ? CoreState.idle : CoreState.error);
                } catch (e) {
                  if (context.mounted) toastError(context, e);
                }
              }
            },
          ),
          IconButton(tooltip: 'New conversation', icon: const Icon(Icons.add_comment_outlined), onPressed: _runId == null ? _newChat : null),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(children: [
          AnimatedContainer(
            duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 320),
            curve: Curves.easeOutCubic,
            height: hasChat ? 150 : MediaQuery.of(context).size.height * .42,
            child: Stack(children: [
              Positioned.fill(child: EnergyCore(state: _core, agent: template, reduceMotion: prefs.reduceMotion, level: _listening ? _level : 0, compact: hasChat)),
              Positioned(
                left: 0,
                right: 0,
                bottom: 8,
                child: Semantics(liveRegion: true, child: Text(coreLabel(_core), textAlign: TextAlign.center, style: qs(13, w: FontWeight.w600, c: q.text2, ls: .4))),
              ),
            ]),
          ),
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          if (!_loading && (_loadError != null || !aiOk)) _AiBanner(error: _loadError, ai: _ai, onRetry: _init),
          Expanded(
            child: !hasChat
                ? _Starters(agent: _agent, onPick: aiOk ? _send : null)
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                    itemCount: _msgs.length,
                    itemBuilder: (_, i) => _Bubble(msg: _msgs[i], agentName: _agent?['name'] as String? ?? 'Assistant', template: template),
                  ),
          ),
          _Composer(
            controller: _input,
            listening: _listening,
            running: _runId != null,
            enabled: !_loading && _loadError == null,
            onSend: () => _send(),
            onMic: _toggleMic,
            onStop: _cancel,
          ),
        ]),
      ),
    );
  }
}

class _AiBanner extends StatelessWidget {
  const _AiBanner({required this.error, required this.ai, required this.onRetry});
  final String? error;
  final Map<String, dynamic>? ai;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final status = ai?['status'] as String?;
    final msg = error ??
        switch (status) {
          'paid_plan_required' => 'AI answers are off: the AI gateway for this server needs prepaid credits. Everything else works. Messages you send will be saved, but no answer will be generated.',
          'not_configured' => 'AI is not configured on this server. Messages will be saved without an answer.',
          _ => (ai?['detail'] as String?) ?? 'AI is unavailable right now.',
        };
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: q.warn.withValues(alpha: .08), borderRadius: BorderRadius.circular(10), border: Border.all(color: q.warn.withValues(alpha: .4))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(Icons.info_outline, size: 18, color: q.warn),
        const SizedBox(width: 10),
        Expanded(child: Text(msg, style: qs(13, c: q.text))),
        TextButton(onPressed: onRetry, child: Text('Recheck', style: qs(13, w: FontWeight.w600, c: q.text))),
      ]),
    );
  }
}

class _AgentPicker extends StatelessWidget {
  const _AgentPicker({required this.agents, required this.selected, required this.onPick});
  final List<Map<String, dynamic>> agents;
  final Map<String, dynamic>? selected;
  final ValueChanged<Map<String, dynamic>>? onPick;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return PopupMenuButton<Map<String, dynamic>>(
      enabled: onPick != null && agents.isNotEmpty,
      tooltip: 'Choose agent',
      onSelected: onPick,
      itemBuilder: (_) => [
        for (final a in agents)
          PopupMenuItem(
            value: a,
            enabled: a['status'] == 'active',
            child: Row(children: [AgentOrb(a['template'] as String?, size: 22, paused: a['status'] != 'active'), const SizedBox(width: 10), Text(a['name'] as String), if (a['status'] != 'active') Text('  · Paused', style: qs(12, c: q.text3))]),
          ),
      ],
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        AgentOrb(selected?['template'] as String?, size: 24),
        const SizedBox(width: 10),
        Flexible(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(selected?['name'] as String? ?? 'Assistant', overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
            Text(AgentStyle.of(selected?['template'] as String?).role, style: qs(11, c: q.text3)),
          ]),
        ),
        Icon(Icons.expand_more, size: 18, color: q.text3),
      ]),
    );
  }
}

class _Starters extends StatelessWidget {
  const _Starters({required this.agent, required this.onPick});
  final Map<String, dynamic>? agent;
  final ValueChanged<String>? onPick;
  @override
  Widget build(BuildContext context) {
    final t = agent?['template'] as String? ?? 'ceo';
    final prompts = switch (t) {
      'sales' => ['Which contacts haven\'t heard from us in a while?', 'Draft a follow-up email to my newest lead'],
      'finance' => ['What should I watch this week?', 'List tasks tagged with invoices'],
      'operations' => ['What\'s overdue right now?', 'Turn my open tasks into a plan for this week'],
      'marketing' => ['Draft three post ideas for this week', 'Save a note with our brand voice'],
      'research' => ['Search my library for pricing notes', 'Summarise what we know about our customers'],
      _ => ['What needs my attention today?', 'Plan my week from open tasks', 'Add a task to call the accountant on Friday'],
    };
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Try asking', style: qs(12, w: FontWeight.w600, c: context.q.text3, ls: .8)),
      const SizedBox(height: 8),
      for (final p in prompts)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: QCard(onTap: onPick == null ? null : () => onPick!(p), padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12), child: Text(p, style: qs(14, c: onPick == null ? context.q.text3 : context.q.text))),
        ),
    ]);
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.msg, required this.agentName, required this.template});
  final _Msg msg;
  final String agentName;
  final String template;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    if (msg.role == 'user') {
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.only(bottom: 10, left: 48),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(color: q.surface2, borderRadius: BorderRadius.circular(14), border: Border.all(color: q.line)),
          child: SelectableText(msg.text, style: qs(15, c: q.text)),
        ),
      );
    }
    if (msg.role == 'system_notice' && msg.error == null) {
      return Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(msg.text, textAlign: TextAlign.center, style: qs(12, c: q.text3)));
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 14, right: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (msg.role == 'assistant') Row(children: [AgentOrb(template, size: 16), const SizedBox(width: 6), Text(agentName, style: qs(12, w: FontWeight.w600, c: q.text3))]),
        for (final s in msg.steps ?? const <_Step>[])
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(children: [
              if (s.ok == null)
                const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 1.6))
              else
                Icon(s.ok! ? Icons.check_circle_outline : Icons.error_outline, size: 15, color: s.ok! ? q.ok : q.bad),
              const SizedBox(width: 8),
              Flexible(child: Text(s.summary, style: qs(13, c: q.text2))),
              const SizedBox(width: 6),
              Text(s.tool, style: qs(11, c: q.text3, family: mono)),
            ]),
          ),
        if (msg.text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: SelectableText(msg.text, style: qs(15, c: q.text, h: 1.5))),
        if (msg.approval != null) _InlineApproval(data: msg.approval!),
        if (msg.error != null)
          Container(
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: q.bad.withValues(alpha: .5)), color: q.bad.withValues(alpha: .06)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(Icons.error_outline, size: 16, color: q.bad), const SizedBox(width: 8), Expanded(child: Text(msg.error!, style: qs(13, c: q.text)))]),
          ),
      ]),
    );
  }
}

class _InlineApproval extends StatelessWidget {
  const _InlineApproval({required this.data});
  final Map<String, dynamic> data;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final p = (data['preview'] as Map?)?.cast<String, dynamic>() ?? {};
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: q.halo.withValues(alpha: .6)), color: q.halo.withValues(alpha: .05)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Icon(Icons.verified_user_outlined, size: 16, color: q.halo), const SizedBox(width: 6), Text('Needs your approval', style: qs(13, w: FontWeight.w600, c: q.halo)), const Spacer(), RiskTag(data['risk'] as String?)]),
        const SizedBox(height: 8),
        Text(p['title'] as String? ?? '${data['action']}', style: qs(15, w: FontWeight.w600, c: q.text)),
        for (final l in (p['lines'] as List? ?? const [])) Padding(padding: const EdgeInsets.only(top: 4), child: Text('$l', maxLines: 3, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2))),
        const SizedBox(height: 12),
        QButton('Review', kind: QBtn.halo, expand: true, onPressed: () => push(context, ApprovalDetail(id: data['approvalId'] as String))),
      ]),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.listening, required this.running, required this.enabled, required this.onSend, required this.onMic, required this.onStop});
  final TextEditingController controller;
  final bool listening, running, enabled;
  final VoidCallback onSend, onMic, onStop;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: q.line))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(
          child: TextField(
            controller: controller,
            enabled: enabled && !running,
            minLines: 1,
            maxLines: 5,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => onSend(),
            decoration: InputDecoration(hintText: listening ? 'Listening…' : 'Ask or tell your team', isDense: true),
          ),
        ),
        const SizedBox(width: 8),
        if (running)
          IconButton.filledTonal(tooltip: 'Stop', onPressed: onStop, icon: const Icon(Icons.stop), iconSize: 22, constraints: const BoxConstraints.tightFor(width: 48, height: 48))
        else ...[
          IconButton.filledTonal(
            tooltip: listening ? 'Stop listening' : 'Speak (turn-based)',
            isSelected: listening,
            onPressed: enabled ? onMic : null,
            icon: Icon(listening ? Icons.mic : Icons.mic_none),
            constraints: const BoxConstraints.tightFor(width: 48, height: 48),
          ),
          const SizedBox(width: 6),
          IconButton.filled(
            tooltip: 'Send',
            style: IconButton.styleFrom(backgroundColor: q.surface2, foregroundColor: q.text, side: BorderSide(color: q.lineStrong)),
            onPressed: enabled ? onSend : null,
            icon: const Icon(Icons.arrow_upward),
            constraints: const BoxConstraints.tightFor(width: 48, height: 48),
          ),
        ],
      ]),
    );
  }
}

class _History extends StatelessWidget {
  const _History();
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return SizedBox(
      height: MediaQuery.of(context).size.height * .6,
      child: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/conversations')),
        builder: (context, list, _) => list.isEmpty
            ? const EmptyState(icon: Icons.forum_outlined, title: 'No conversations yet')
            : ListView(children: [
                Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('Conversations', style: qs(16, w: FontWeight.w600, c: q.text))),
                for (final c in list)
                  ListTile(
                    leading: AgentOrb(c['template'] as String?, size: 28),
                    title: Text(c['title'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${c['agent_name']} · ${ago(c['updated_at'] as String?)}', maxLines: 1),
                    onTap: () => Navigator.pop(context, c['id'] as String),
                  ),
              ]),
      ),
    );
  }
}
