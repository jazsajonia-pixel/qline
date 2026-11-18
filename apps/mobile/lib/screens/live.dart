import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../core/api.dart';
import '../core/chat_resume.dart';
import '../core/session.dart';
import '../core/voice.dart';
import '../ui/activity_trace.dart';
import '../ui/chat_artifacts.dart';
import '../ui/core_painter.dart';
import '../ui/markdown.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'ai.dart';
import 'approvals.dart';
import 'knowledge_graph.dart';
import 'needs_checking.dart';

class _Msg {
  _Msg(this.role, this.text, {this.steps, this.error, this.speech, this.suggestions = const [], this.agentName, this.template, this.attachments = const [], this.knowledge = const [], this.runId, this.stepCount = 0, List<Map<String, dynamic>>? artifacts}) : artifacts = artifacts ?? [];
  /// Run 3: knowledge entries the person added to this message ({id, title, status}).
  final List<Map<String, dynamic>> knowledge;
  /// Run 3: for answers from history, the run whose steps can be opened, and how many there were.
  final String? runId;
  final int stepCount;
  /// v1.6 run 2: files sent with a user message ({id, name, mime, kind, size}).
  final List<Map<String, dynamic>> attachments;
  /// v1.6 run 2: charts and images the AI showed in this answer.
  final List<Map<String, dynamic>> artifacts;
  final String role;
  String text;
  /// v1.6: what the voice says (short), separate from the written answer.
  String? speech;
  /// v1.6: follow-up prompts shown under the latest answer.
  List<String> suggestions;
  /// v1.6: which agent answered (automatic switching can change it per message).
  String? agentName, template;
  List<TraceStep>? steps;
  /// True while tokens are still arriving.
  bool streaming = false;
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
  late final Speaker _voice = Speaker(
    onWord: (i) {
      if (mounted && i != _word) setState(() => _word = i);
    },
    onLevel: (l) {
      if (mounted && (l - _speakLevel).abs() > .01) setState(() => _speakLevel = l);
    },
    onDone: _afterSpeech,
    onNotice: (m) {
      if (mounted) toast(context, m);
    },
  );
  bool _handsFree = false, _busy = false;
  bool _leaving = false;

  /// Run 3 / M4B: knowledge entries chosen for the next message ({id, title}). At most [maxChatKnowledge].
  final List<Map<String, String>> _knowledge = [];

  Future<void> _openKnowledge() async {
    final picked = await showKnowledgeSheet(context, already: {for (final k in _knowledge) k['id']!});
    if (picked == null || !mounted) return;
    if (_knowledge.length >= maxChatKnowledge) {
      toast(context, 'You can add up to $maxChatKnowledge knowledge entries to one message.');
      return;
    }
    if (_knowledge.any((k) => k['id'] == picked['id'])) return;
    setState(() => _knowledge.add(picked));
  }
  String _spoken = '';
  int _word = -1;
  double _speakLevel = 0;
  int _sttErrors = 0;
  Timer? _relisten;
  late final UtteranceGate _gate = UtteranceGate(onCommit: _heardRequest);
  bool _loading = true;
  String? _loadError;

  Api get _api => ref.read(apiProvider);

  double get _wordWeight {
    final w = wordsOf(_spoken);
    if (_word < 0 || _word >= w.length) return .5;
    return (syllables(w[_word]) / 3).clamp(0, 1).toDouble();
  }

  Map<String, dynamic>? get _agentAi => items(_ai, 'agents').where((a) => a['id'] == _agent?['id']).firstOrNull;
  /// v1.6: Auto picks the right specialist for each message (the server routes it); on by default.
  bool _auto = true;
  /// The agent whose colours the core shows: the one answering now.
  String? _liveTemplate;
  bool get _agentReady => _agentAi?['ready'] == true;

  @override
  void initState() {
    super.initState();
    _convId = widget.conversationId;
    _init();
  }

  static final _stopPhrase = RegExp(r"^(please )?(stop listening|stop|that'?s all|goodbye|bye|end hands[- ]free|exit)[.!]?$", caseSensitive: false);

  Future<void> _speakReply(String text) async {
    setState(() {
      _spoken = speakable(text);
      _word = -1;
      _core = CoreState.speaking;
    });
    await _voice.speak(_api, text, ref.read(voicePrefsProvider));
  }

  void _afterSpeech() {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _speakLevel = 0;
      if (_core == CoreState.speaking) _core = CoreState.idle;
    });
    if (_handsFree) _scheduleListen();
  }

  void _scheduleListen([int ms = 450]) {
    _relisten?.cancel();
    _relisten = Timer(Duration(milliseconds: ms), () {
      if (mounted && _handsFree && !_busy && !_listening && _runId == null && !_voice.speaking) _listen();
    });
  }

  Future<void> _setHandsFree(bool on) async {
    setState(() => _handsFree = on);
    if (on) {
      try {
        await WakelockPlus.enable();
      } catch (_) {}
      if (mounted) toast(context, 'Hands-free is on. Talk any time; say "stop listening" to end.');
      _sttErrors = 0;
      if (!_busy && _runId == null) await _listen();
    } else {
      _relisten?.cancel();
      try {
        await WakelockPlus.disable();
      } catch (_) {}
      if (_listening) await _stt.stop();
      await _voice.stop();
      if (mounted) {
        setState(() {
          _busy = false;
          _spoken = '';
          if (_core == CoreState.listening || _core == CoreState.speaking) _core = CoreState.idle;
        });
      }
    }
  }

  /// Tap on the core: interrupt speech (and listen again in hands-free), or start/stop the mic.
  Future<void> _tapCore() async {
    if (_core == CoreState.speaking && _voice.speaking) {
      await _voice.stop();
      setState(() {
        _busy = false;
        _core = CoreState.idle;
        _speakLevel = 0;
      });
      if (_handsFree) await _listen();
      return;
    }
    if (_runId != null || _loading || _loadError != null) return;
    await _toggleMic();
  }

  Future<void> _init() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final results = await Future.wait([_api.get('/agents'), _api.get('/ai/overview').catchError((_) => <String, dynamic>{'status': 'unavailable', 'detail': 'Could not check AI status.'})]);
      _agents = items(results[0]);
      _ai = (results[1] as Map).cast<String, dynamic>();
      _agent = _agents.where((a) => a['template'] == 'ceo').firstOrNull ?? _agents.firstOrNull;
      if (_convId != null) {
        await _loadConversation(_convId!);
      } else {
        // M2: continue the conversation you were in (or your most recent one), unless you started a new chat.
        final key = _pointerKey;
        final stored = key == null ? null : await ref.read(chatPointerStoreProvider).read(key).catchError((Object _) => null);
        final r = await resolveConversation(stored: stored, load: _tryLoad, latest: () async => items(await _api.get('/conversations')).firstOrNull?['id'] as String?);
        if (r.note != null && mounted) toast(context, r.note!);
      }
      if (!_agentReady) _core = CoreState.error;
    } on ApiException catch (e) {
      _loadError = e.message;
      _core = e.isNetwork ? CoreState.offline : CoreState.error;
    }
    if (mounted) setState(() => _loading = false);
  }

  /// M2: the remembered chat for this account and organisation.
  String? get _pointerKey {
    final s = ref.read(sessionProvider);
    return s.orgId == null || s.email == null ? null : chatPointerKey(s.orgId!, s.email!);
  }

  void _remember(String value) {
    final key = _pointerKey;
    if (key != null) ref.read(chatPointerStoreProvider).write(key, value).catchError((Object _) {});
  }

  /// Opens [id]; false when it no longer exists or is not this person's (the server answers 404 for both).
  Future<bool> _tryLoad(String id) async {
    try {
      await _loadConversation(id);
      return true;
    } on ApiException catch (e) {
      if (e.status == 404) return false;
      rethrow;
    }
  }

  Future<void> _loadConversation(String id) async {
    final c = await _api.get('/conversations/$id') as Map;
    _convId = id;
    _remember(id);
    _agent = _agents.where((a) => a['id'] == c['agent_id']).firstOrNull ?? _agent;
    _msgs
      ..clear()
      ..addAll(items(c, 'messages').map((m) {
        final meta = (m['meta'] as Map?)?.cast<String, dynamic>() ?? const {};
        List<Map<String, dynamic>> maps(Object? v) => ((v as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
        return _Msg(m['role'] as String, m['content'] as String,
            speech: meta['speech'] as String?,
            suggestions: ((meta['suggestions'] as List?) ?? const []).whereType<String>().toList(),
            attachments: maps(meta['attachments']),
            artifacts: maps(meta['artifacts']),
            knowledge: maps(meta['knowledge']),
            runId: m['run_id'] as String?,
            stepCount: (m['steps'] as num?)?.toInt() ?? 0);
      }));
    if (mounted) setState(() {});
    _toBottom();
    // M2: an answer was still being written when the app closed: follow it to the end.
    final active = (c['active_run'] as Map?)?.cast<String, dynamic>();
    if (active != null && _runId == null && mounted) {
      _runId = active['id'] as String;
      _busy = true;
      _core = CoreState.thinking;
      _stream(_runId!, resumed: true);
    }
  }

  void _toBottom() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      });

  late final ChatAttachments _files = ChatAttachments(() => _api)..addListener(() {
      if (mounted) setState(() {});
    });
  List<PendingFile> get _pending => _files.items;

  Future<void> _attach() async {
    if (_files.full) {
      toast(context, 'You can attach up to $maxChatAttachments files to one message.');
      return;
    }
    final ChatFile? f;
    try {
      f = await pickChatFile();
    } catch (e) {
      if (mounted) toastError(context, e);
      return;
    }
    if (f == null || !mounted) return;
    try {
      final note = await _files.add(f);
      if (note != null && mounted) toast(context, note);
    } on AttachmentTooLarge catch (e) {
      if (mounted) toast(context, e.toString());
    } catch (e) {
      if (mounted) toastError(context, e);
    }
  }

  Future<void> _send([String? text]) async {
    final content = (text ?? _input.text).trim();
    if (_runId != null) return;
    if (_files.uploading) {
      toast(context, 'Wait for the upload to finish, then send.');
      return;
    }
    final sending = _files.take();
    if (content.isEmpty && sending.isEmpty) {
      if (_knowledge.isNotEmpty) toast(context, 'Write a message to go with the knowledge you added.');
      return;
    }
    final knowledge = [..._knowledge];
    _knowledge.clear();
    _input.clear();
    _busy = true;
    _relisten?.cancel();
    if (_listening) await _stt.stop();
    await _voice.stop();
    setState(() {
      _spoken = '';
      _msgs.add(_Msg('user', content, attachments: [for (final p in sending) p.toMeta()], knowledge: knowledge));
      _core = CoreState.thinking;
    });
    _toBottom();
    try {
      if (_convId == null) {
        _convId = ((await _api.post('/conversations', {if (_agent != null) 'agentId': _agent!['id']})) as Map)['id'] as String;
        _remember(_convId!);
      }
      final r = await _api.post('/conversations/$_convId/messages', {
        'content': content,
        if (sending.isNotEmpty) 'attachments': [for (final p in sending) p.id],
        if (knowledge.isNotEmpty) 'knowledge': [for (final k in knowledge) k['id']],
        if (_auto) 'agent': 'auto',
      }) as Map;
      _runId = r['runId'] as String;
      final routed = (r['agent'] as Map?)?.cast<String, dynamic>();
      _stream(_runId!, agentName: routed?['name'] as String?, template: routed?['template'] as String?);
    } on ApiException catch (e) {
      setState(() {
        // Keep the files so the person can send again without re-uploading.
        _files.restore(sending);
        _knowledge
          ..clear()
          ..addAll(knowledge);
        _msgs.add(_Msg('system_notice', '', error: e.message));
        _core = e.isNetwork ? CoreState.offline : CoreState.error;
        _busy = false;
      });
      if (_handsFree) _scheduleListen(1500);
    }
  }

  /// [resumed]: following an answer that started before the app reopened; it is shown, not spoken.
  void _stream(String runId, {String? lastId, String? agentName, String? template, bool resumed = false}) {
    final reply = _Msg('assistant', '', steps: [], agentName: agentName, template: template)..streaming = true;
    setState(() {
      for (final m in _msgs) {
        m.suggestions = const [];
      }
      _msgs.add(reply);
      _liveTemplate = template;
    });
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
              // Writing is not speaking: the core only shows "speaking" while the voice is actually playing.
              _core = CoreState.thinking;
            case 'meta':
              reply.speech = d['speech'] as String?;
              reply.suggestions = ((d['suggestions'] as List?) ?? const []).whereType<String>().take(3).toList();
            case 'tool.planned':
              reply.steps!.add(TraceStep.planned(d));
              _core = CoreState.tool;
            case 'tool.result':
              final s = reply.steps!.where((s) => s.id == d['stepId']).lastOrNull ?? reply.steps!.lastOrNull;
              s?.result(d);
              _core = CoreState.thinking;
            case 'artifact':
              if (reply.artifacts.length < 6) reply.artifacts.add(d);
            case 'approval.required':
              reply.approval = d;
              _core = CoreState.approval;
            case 'error':
              reply.error = d['message'] as String? ?? 'Something went wrong.';
              _core = CoreState.error;
            case 'done':
              reply.streaming = false;
              if (_core != CoreState.approval && _core != CoreState.error) _core = d['status'] == 'waiting_approval' ? CoreState.approval : CoreState.success;
          }
        });
        _toBottom();
      },
      onError: (Object err) {
        setState(() {
          reply.streaming = false;
          reply.error = err is ApiException ? err.message : 'The connection dropped. The answer is still saved; reopen this conversation to see it.';
          _core = err is ApiException && !err.isNetwork ? CoreState.error : CoreState.offline;
          _runId = null;
        });
      },
      onDone: () async {
        _runId = null;
        reply.streaming = false;
        ref.read(refreshTick.notifier).bump();
        if (!mounted) return;
        if (reply.text.isEmpty && reply.artifacts.isEmpty && reply.error == null && reply.approval == null && (reply.steps?.isEmpty ?? true)) {
          setState(() => reply.error = 'No answer came back. Try again.');
        }
        final voiceOn = !resumed && (_handsFree || ref.read(prefsProvider).speak);
        if (_core == CoreState.success) {
          if (voiceOn && reply.text.isNotEmpty) {
            // Speak the short spoken line, not the whole written answer.
            await _speakReply(spokenLine(reply.speech, reply.text));
          } else {
            await Future<void>.delayed(const Duration(milliseconds: 900));
            if (mounted && _core == CoreState.success) setState(() => _core = CoreState.idle);
            _afterSpeech();
          }
        } else if (_handsFree && _core == CoreState.approval) {
          await _speakReply('That needs your approval. I put it on the screen for you.');
        } else if (_handsFree && reply.error != null) {
          await _speakReply('Sorry, that did not work. ${reply.error}');
        } else {
          if (_core == CoreState.speaking || _core == CoreState.thinking) setState(() => _core = CoreState.idle);
          _afterSpeech();
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
    if (_handsFree) return _setHandsFree(false);
    if (_listening) {
      await _stt.stop();
      return;
    }
    await _listen();
  }

  Future<bool> _ensureStt() async {
    if (_sttReady) return true;
    _sttReady = await _stt.initialize(
      onStatus: (s) {
        if ((s == 'done' || s == 'notListening') && mounted) {
          setState(() {
            _listening = false;
            if (_core == CoreState.listening) _core = CoreState.idle;
          });
          _gate.ended(); // sends whatever was heard, even if no final result came
          if (_handsFree && !_gate.committed) _scheduleListen();
        }
      },
      onError: (e) {
        if (!mounted) return;
        final quiet = e.errorMsg == 'error_no_match' || e.errorMsg == 'error_speech_timeout';
        setState(() {
          _listening = false;
          if (_core == CoreState.listening) _core = CoreState.idle;
        });
        if (_gate.heard.isNotEmpty) {
          _gate.ended(); // keep what was already heard instead of dropping it
          return;
        }
        if (_handsFree) {
          if (!quiet && ++_sttErrors >= 3) {
            _setHandsFree(false);
            toast(context, 'Hands-free stopped: voice input keeps failing (${e.errorMsg.replaceAll('_', ' ')}).');
          } else {
            _scheduleListen(quiet ? 300 : 1200);
          }
          return;
        }
        toast(context, e.errorMsg == 'error_no_match' ? 'Didn\'t catch that. Try again.' : 'Voice input stopped: ${e.errorMsg.replaceAll('_', ' ')}');
      },
    );
    if (!_sttReady && mounted) {
      toast(context, 'Voice input is unavailable. Allow microphone access or install a speech service.');
      if (_handsFree) _setHandsFree(false);
    }
    return _sttReady;
  }

  Future<void> _listen() async {
    if (!mounted || _listening || _runId != null) return;
    if (!await _ensureStt()) return;
    await _voice.stop();
    if (!mounted) return;
    _gate
      ..reset()
      ..silence = Duration(milliseconds: _handsFree ? 1500 : 1300);
    setState(() {
      _listening = true;
      _core = CoreState.listening;
      _spoken = '';
    });
    await _stt.listen(
      onResult: (SpeechRecognitionResult r) {
        if (_gate.committed) return;
        setState(() => _input.text = r.recognizedWords);
        _gate.feed(r.recognizedWords, isFinal: r.finalResult);
      },
      onSoundLevelChange: (l) => setState(() => _level = ((l + 2) / 12).clamp(0, 1).toDouble()),
      listenOptions: SpeechListenOptions(
        partialResults: true,
        cancelOnError: true,
        listenMode: ListenMode.dictation,
        listenFor: Duration(seconds: _handsFree ? 60 : 30),
        pauseFor: Duration(milliseconds: _handsFree ? 2200 : 3000),
      ),
    );
  }

  /// The user finished speaking: send it (or end hands-free on a stop phrase).
  void _heardRequest(String words) {
    if (!mounted) return;
    _sttErrors = 0;
    if (_listening) _stt.stop();
    if (_handsFree && _stopPhrase.hasMatch(words)) {
      _input.clear();
      _setHandsFree(false);
      return;
    }
    _send(words);
  }

  /// New chat is always explicit: reopening the app continues the current conversation (M2).
  void _newChat() {
    _remember(newChatPointer);
    _sub?.cancel();
    _voice.stop();
    setState(() {
      _spoken = '';
      _busy = false;
      _convId = null;
      _runId = null;
      _msgs.clear();
      _files.take();
      _core = _agentReady ? CoreState.idle : CoreState.error;
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _stt.cancel();
    _relisten?.cancel();
    _gate.dispose();
    _voice.dispose();
    if (_handsFree) WakelockPlus.disable();
    _input.dispose();
    _scroll.dispose();
    _files.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final prefs = ref.watch(prefsProvider);
    final aiOk = _agentReady;
    final hasChat = _msgs.isNotEmpty;
    final template = _agent?['template'] as String? ?? 'ceo';
    // Run 3 / M5: leaving the chat with an upload or an unsent message asks first. Nothing else is lost
    // (answers keep being written on the server; listening stops when the screen closes).
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop || _leaving) return;
        final unsent = _files.uploading ? 'A file is still uploading and will not be sent.' : (_input.text.trim().isNotEmpty || _pending.isNotEmpty ? 'Your unsent message will be discarded.' : null);
        if (unsent != null) {
          _leaving = true;
          final ok = await confirm(context, title: 'Leave the chat?', body: unsent, action: 'Leave');
          _leaving = false;
          if (!ok || !context.mounted) return;
        }
        if (context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
      backgroundColor: QColors.liveInk,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        leading: IconButton(tooltip: 'Close', icon: const Icon(Icons.close), onPressed: () => Navigator.maybePop(context)),
        title: _AgentPicker(
            agents: _agents,
            selected: _agent,
            auto: _auto,
            model: _auto ? null : (_agentAi?['effective'] == null ? null : (_agentAi!['effective'] as Map)['model'] as String?),
            onPick: _runId != null
                ? null
                : (a) => setState(() {
                      _auto = a['id'] == 'auto';
                      _agent = _auto ? (_agents.where((x) => x['template'] == 'ceo').firstOrNull ?? _agent) : a;
                      _liveTemplate = null;
                      _newChat();
                    })),
        actions: [
          IconButton(tooltip: prefs.speak ? 'Spoken replies on' : 'Spoken replies off', icon: Icon(prefs.speak ? Icons.volume_up_outlined : Icons.volume_off_outlined), onPressed: () => ref.read(prefsProvider.notifier).set(speak: !prefs.speak)),
          IconButton(
            tooltip: 'Conversations',
            icon: const Icon(Icons.history),
            onPressed: () async {
              final id = await showModalBottomSheet<String>(context: context, builder: (_) => Theme(data: buildTheme(false), child: _History(canStartNew: _runId == null)));
              if (id == newChatPointer) {
                _newChat();
              } else if (id != null) {
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
          IconButton(tooltip: 'New chat', icon: const Icon(Icons.add_comment_outlined), onPressed: _runId == null ? _newChat : null),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(children: [
          // The core keeps its own band at the top; the conversation sits below it and never covers it.
          // It grows while listening or speaking so the voice animation stays the focus.
          AnimatedContainer(
            duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 360),
            curve: Curves.easeOutCubic,
            height: coreHeight(MediaQuery.of(context).size.height, hasChat: hasChat, voiceActive: _listening || _core == CoreState.speaking),
            child: Column(children: [
              Expanded(
                child: Semantics(
                  button: true,
                  label: _core == CoreState.speaking ? 'Stop speaking' : (_listening ? 'Stop listening' : 'Start talking'),
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: _tapCore,
                    child: EnergyCore(
                      state: _core,
                      agent: _liveTemplate ?? template,
                      reduceMotion: prefs.reduceMotion,
                      level: _listening ? _level : (_core == CoreState.speaking ? _speakLevel : 0),
                      word: _core == CoreState.speaking ? _word : -1,
                      wordWeight: _wordWeight,
                      compact: hasChat,
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 6, top: 2),
                child: Semantics(
                  liveRegion: true,
                  child: _core == CoreState.speaking && _spoken.isNotEmpty
                      // While speaking, show the spoken line (it is shorter than, and differs from, the written answer).
                      ? Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: Text(_spoken, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2, h: 1.35)))
                      : Text(coreLabel(_core), textAlign: TextAlign.center, style: qs(13, w: FontWeight.w600, c: q.text2, ls: .4)),
                ),
              ),
            ]),
          ),
          if (_handsFree) HandsFreeBar(listening: _listening, speaking: _core == CoreState.speaking, onEnd: () => _setHandsFree(false)),
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          if (!_loading && (_loadError != null || !aiOk)) _AiBanner(
                error: _loadError,
                ai: _ai,
                agentAi: _agentAi,
                onRetry: _init,
                onSetup: () async {
                  await push(context, const AiProvidersScreen());
                  if (mounted) await _init();
                },
              ),
          Expanded(
            child: !hasChat
                ? _Starters(agent: _agent, onPick: aiOk ? _send : null)
                : ShaderMask(
                    // Messages fade out as they scroll up toward the core instead of cutting into it.
                    shaderCallback: (r) => const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xFF000000)], stops: [0, .08]).createShader(r),
                    blendMode: BlendMode.dstIn,
                    child: ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
                      itemCount: _msgs.length,
                      itemBuilder: (_, i) => _Bubble(
                        msg: _msgs[i],
                        agentName: _msgs[i].agentName ?? _agent?['name'] as String? ?? 'Assistant',
                        template: _msgs[i].template ?? template,
                        onSuggestion: i == _msgs.length - 1 && _runId == null && aiOk ? _send : null,
                      ),
                    ),
                  ),
          ),
          _Composer(
            controller: _input,
            listening: _listening,
            handsFree: _handsFree,
            onHandsFree: () => _setHandsFree(!_handsFree),
            running: _runId != null,
            enabled: !_loading && _loadError == null,
            onSend: () => _send(),
            onMic: _toggleMic,
            onStop: _cancel,
            onAttach: _attach,
            onKnowledge: _openKnowledge,
            pending: [
              for (final k in _knowledge)
                InputChip(
                  avatar: Icon(Icons.hub_outlined, size: 16, color: q.text2),
                  label: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 180), child: Text(k['title']!, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(12, c: q.text))),
                  tooltip: 'Using ${k['title']} in this message',
                  deleteButtonTooltipMessage: 'Remove ${k['title']}',
                  onDeleted: _runId != null ? null : () => setState(() => _knowledge.remove(k)),
                  visualDensity: VisualDensity.compact,
                ),
              for (final p in _pending)
                AttachmentChip(name: p.name, kind: p.kind, size: p.size, uploading: p.uploading, onRemove: _runId != null ? null : () => _files.remove(p)),
            ],
          ),
        ]),
      ),
      ),
    );
  }
}

class _AiBanner extends StatelessWidget {
  const _AiBanner({required this.error, required this.ai, required this.agentAi, required this.onRetry, required this.onSetup});
  final String? error;
  final Map<String, dynamic>? ai;
  final Map<String, dynamic>? agentAi;
  final VoidCallback onRetry;
  final VoidCallback onSetup;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final status = ai?['status'] as String?;
    final eff = agentAi?['effective'] as Map?;
    final msg = error ??
        switch (status) {
          'not_configured' => 'No AI provider is connected yet. Add a key for any of the five providers to get answers. Messages are saved either way.',
          'no_default' when eff == null => 'Pick a default model in AI providers, or give this agent its own model.',
          'unavailable' => (ai?['detail'] as String?) ?? 'Could not check AI status.',
          _ => eff == null ? 'This agent has no model yet.' : 'This agent uses ${modelLabel(eff, items(ai, 'providers'))}, which isn\'t connected. Pick another model or add that key.',
        };
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: q.warn.withValues(alpha: .08), borderRadius: BorderRadius.circular(10), border: Border.all(color: q.warn.withValues(alpha: .4))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(Icons.info_outline, size: 18, color: q.warn),
        const SizedBox(width: 10),
        Expanded(child: Text(msg, style: qs(13, c: q.text))),
        if (error == null && status != 'unavailable')
          TextButton(onPressed: onSetup, child: Text('Set up AI', style: qs(13, w: FontWeight.w600, c: q.text)))
        else
          TextButton(onPressed: onRetry, child: Text('Recheck', style: qs(13, w: FontWeight.w600, c: q.text))),
      ]),
    );
  }
}

class _AgentPicker extends StatelessWidget {
  const _AgentPicker({required this.agents, required this.selected, required this.onPick, this.model, this.auto = false});
  final String? model;
  final bool auto;
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
        PopupMenuItem(
          value: const {'id': 'auto', 'name': 'Auto', 'template': 'ceo', 'status': 'active'},
          child: Row(children: [const Icon(Icons.auto_awesome, size: 20), const SizedBox(width: 10), const Text('Auto'), Text('  · picks the right agent', style: qs(12, c: q.text3))]),
        ),
        const PopupMenuDivider(),
        for (final a in agents)
          PopupMenuItem(
            value: a,
            enabled: a['status'] == 'active',
            child: Row(children: [AgentOrb(a['template'] as String?, size: 22, paused: a['status'] != 'active'), const SizedBox(width: 10), Text(a['name'] as String), if (a['status'] != 'active') Text('  · Paused', style: qs(12, c: q.text3))]),
          ),
      ],
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        auto ? const Icon(Icons.auto_awesome, size: 22) : AgentOrb(selected?['template'] as String?, size: 24),
        const SizedBox(width: 10),
        Flexible(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(auto ? 'Auto' : selected?['name'] as String? ?? 'Assistant', overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
            Text(auto ? 'Picks the right agent' : (model == null ? AgentStyle.of(selected?['template'] as String?).role : model!), overflow: TextOverflow.ellipsis, style: qs(11, c: q.text3, family: model == null || auto ? ui : mono)),
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
  const _Bubble({required this.msg, required this.agentName, required this.template, this.onSuggestion});
  final _Msg msg;
  final ValueChanged<String>? onSuggestion;
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
          child: Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
            if (msg.text.isNotEmpty) SelectableText(msg.text, style: qs(15, c: q.text)),
            // Run 3 / M4C: which knowledge this message carried into the AI's context.
            if (msg.knowledge.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(alignment: WrapAlignment.end, spacing: 6, runSpacing: 6, children: [
                  for (final k in msg.knowledge)
                    Semantics(
                      label: 'Using knowledge: ${k['title']}',
                      excludeSemantics: true,
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(Icons.hub_outlined, size: 13, color: q.text3),
                        const SizedBox(width: 4),
                        ConstrainedBox(constraints: const BoxConstraints(maxWidth: 200), child: Text('${k['title']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(12, c: q.text2))),
                      ]),
                    ),
                ]),
              ),
            for (final a in msg.attachments)
              if (a['kind'] == 'image' && a['id'] != null)
                SizedBox(width: 220, child: ChatImage(fileId: a['id'] as String, name: a['name'] as String? ?? 'Image', height: 160, compact: true))
              else
                Padding(padding: const EdgeInsets.only(top: 6), child: AttachmentChip(name: a['name'] as String? ?? 'File', kind: a['kind'] as String?, size: a['size'] as num?)),
          ]),
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
        // Run 3: one quiet line for what the AI did; important steps stay visible (activity_trace.dart).
        if ((msg.steps?.isNotEmpty ?? false) || (msg.runId != null && msg.stepCount > 0))
          ActivityTrace(steps: msg.steps ?? const [], runId: msg.runId, onAttention: () => push(context, const NeedsCheckingScreen())),
        if (msg.text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: MarkdownText(msg.text, streaming: msg.streaming)),
        for (final a in msg.artifacts) ChatArtifact(a),
        if (msg.approval != null) _InlineApproval(data: msg.approval!),
        if (onSuggestion != null && msg.role == 'assistant' && msg.suggestions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final s in msg.suggestions)
                ActionChip(
                  avatar: Icon(Icons.subdirectory_arrow_right, size: 16, color: q.text2),
                  label: Text(s, style: qs(13, c: q.text)),
                  onPressed: () => onSuggestion!(s),
                  tooltip: 'Ask: $s',
                ),
            ]),
          ),
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
  const _Composer({required this.controller, required this.listening, required this.handsFree, required this.onHandsFree, required this.running, required this.enabled, required this.onSend, required this.onMic, required this.onStop, required this.onAttach, this.onKnowledge, this.pending = const []});
  final TextEditingController controller;
  final bool listening, running, enabled, handsFree;
  final VoidCallback onSend, onMic, onStop, onHandsFree, onAttach;
  final VoidCallback? onKnowledge;
  final List<Widget> pending;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: q.line))),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (pending.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Align(alignment: Alignment.centerLeft, child: Wrap(spacing: 6, runSpacing: 6, children: pending)),
          ),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        // Run 3 / M4B: the knowledge map, to the left of the composer; it opens over the chat.
        if (onKnowledge != null) ...[
          IconButton(
            tooltip: 'Add knowledge',
            onPressed: enabled && !running ? onKnowledge : null,
            icon: Icon(Icons.hub_outlined, color: q.text2),
            constraints: const BoxConstraints.tightFor(width: 44, height: 48),
          ),
          const SizedBox(width: 2),
        ],
        Expanded(
          child: TextField(
            controller: controller,
            enabled: enabled && !running,
            minLines: 1,
            maxLines: 5,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => onSend(),
            decoration: InputDecoration(
              hintText: listening ? 'Listening…' : 'Ask or tell your team',
              isDense: true,
              prefixIcon: IconButton(tooltip: 'Attach a photo or file', onPressed: enabled && !running ? onAttach : null, icon: const Icon(Icons.attach_file)),
            ),
          ),
        ),
        const SizedBox(width: 8),
        if (running)
          IconButton.filledTonal(tooltip: 'Stop', onPressed: onStop, icon: const Icon(Icons.stop), iconSize: 22, constraints: const BoxConstraints.tightFor(width: 48, height: 48))
        else ...[
          IconButton.filledTonal(
            tooltip: handsFree ? 'End hands-free' : 'Hands-free: keep listening',
            isSelected: handsFree,
            style: handsFree ? IconButton.styleFrom(backgroundColor: q.halo, foregroundColor: q.onHalo) : null,
            onPressed: enabled ? onHandsFree : null,
            icon: Icon(handsFree ? Icons.hearing : Icons.hearing_outlined),
            constraints: const BoxConstraints.tightFor(width: 48, height: 48),
          ),
          const SizedBox(width: 6),
          IconButton.filledTonal(
            tooltip: listening ? 'Stop listening' : 'Speak once',
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
      ]),
    );
  }
}

class _History extends StatelessWidget {
  const _History({this.canStartNew = true});
  final bool canStartNew;
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
                ListTile(
                  enabled: canStartNew,
                  leading: const Icon(Icons.add_comment_outlined),
                  title: const Text('New chat'),
                  subtitle: Text(canStartNew ? 'Start an empty conversation' : 'Wait for the current answer to finish', maxLines: 1),
                  onTap: () => Navigator.pop(context, newChatPointer),
                ),
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

/// Height of the core band: big when the chat is empty, a steady band once messages exist,
/// and a little larger while listening or speaking.
double coreHeight(double screen, {required bool hasChat, required bool voiceActive}) {
  if (!hasChat) return screen * .42;
  final base = (screen * .27).clamp(180.0, 250.0);
  return voiceActive ? (screen * .36).clamp(base, 320.0) : base;
}

class HandsFreeBar extends StatelessWidget {
  const HandsFreeBar({super.key, required this.listening, required this.speaking, required this.onEnd});
  final bool listening, speaking;
  final VoidCallback onEnd;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final msg = speaking ? 'Hands-free · tap the core to interrupt' : (listening ? 'Hands-free · listening for you' : 'Hands-free · working…');
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 6),
      padding: const EdgeInsets.fromLTRB(14, 4, 4, 4),
      decoration: BoxDecoration(color: q.halo.withValues(alpha: .08), borderRadius: BorderRadius.circular(999), border: Border.all(color: q.halo.withValues(alpha: .45))),
      child: Row(children: [
        Icon(Icons.hearing, size: 16, color: q.halo),
        const SizedBox(width: 8),
        Expanded(child: Semantics(liveRegion: true, child: Text(msg, style: qs(13, w: FontWeight.w600, c: q.text)))),
        TextButton(onPressed: onEnd, child: Text('End', style: qs(13, w: FontWeight.w700, c: q.halo))),
      ]),
    );
  }
}
