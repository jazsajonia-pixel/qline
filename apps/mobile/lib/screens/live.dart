import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../core/alerts.dart';
import '../core/api.dart';
import '../core/chat_resume.dart';
import '../core/live_audio.dart';
import '../core/live_conversation.dart';
import '../core/live_status.dart';
import '../core/neural_voice.dart';
import '../core/session.dart';
import '../core/vad.dart';
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
  /// Voice v2: the reply already started talking while it streamed (its spoken lines came early).
  bool spokeEarly = false;

  /// v1.12: the user talked over this reply and it was stopped.
  bool interrupted = false;
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
/// An answer being followed: which run, its bubble, the last event seen and whether to speak it.
class _Following {
  _Following(this.runId, this.reply, {this.lastId, required this.voiceOn, required this.resumed, this.live = false});
  final String runId;

  /// v1.12: spoken by the live conversation as it streams (docs/30).
  final bool live;
  final _Msg reply;
  String? lastId;
  final bool resumed;

  /// Turned off when the user talks over the reply, so later spoken lines stay quiet.
  bool voiceOn;
  int attempts = 0;
  bool done = false;
}

class LiveScreen extends ConsumerWidget {
  const LiveScreen({super.key, this.conversationId, this.embedded = false, this.coreKey});
  final String? conversationId;

  /// Background continuity: shown as a layer of the main shell. Close and Back minimize it into the
  /// navbar orb instead of disposing it, so the answer, the voice and the conversation keep going.
  final bool embedded;

  /// Lets the shell find the core on screen for the orb animation.
  final GlobalKey? coreKey;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Theme(data: buildTheme(false), child: _Live(conversationId: conversationId, embedded: embedded, coreKey: coreKey));
}

class _Live extends ConsumerStatefulWidget {
  const _Live({this.conversationId, this.embedded = false, this.coreKey});
  final String? conversationId;
  final bool embedded;
  final GlobalKey? coreKey;
  @override
  ConsumerState<_Live> createState() => _LiveState();
}

class _LiveState extends ConsumerState<_Live> with WidgetsBindingObserver {
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
      if (_core == CoreState.speaking) liveLevel.value = l;
      if (mounted && (l - _speakLevel).abs() > .01) setState(() => _speakLevel = l);
    },
    onStart: (text) {
      if (!mounted) return;
      setState(() {
        _spoken = speakable(text);
        _word = -1;
        if (_core != CoreState.approval && _core != CoreState.error) _core = CoreState.speaking;
      });
      _startBargeIn();
    },
    onDone: _afterSpeech,
    onNotice: (m) {
      if (mounted) toast(context, m);
    },
  );
  bool _handsFree = false, _busy = false;
  bool _leaving = false;

  // ---- v1.12 live conversation (docs/30) ------------------------------------------------------------
  /// Hands-free with the Qline voice: one echo-cancelled microphone, streamed speech and barge-in.
  LiveConversation? _conv;
  SileroDetector? _vad;
  LiveVoiceState _liveState = LiveVoiceState.off;
  bool get _talking => _voice.speaking || (_conv?.speaking ?? false);

  CoreState _coreFor(LiveVoiceState s) => switch (s) {
        LiveVoiceState.listening || LiveVoiceState.userSpeaking || LiveVoiceState.interrupted => CoreState.listening,
        LiveVoiceState.thinking => _core == CoreState.tool || _core == CoreState.approval ? _core : CoreState.thinking,
        LiveVoiceState.speaking => CoreState.speaking,
        LiveVoiceState.reconnecting => CoreState.offline,
        LiveVoiceState.error => CoreState.error,
        LiveVoiceState.off || LiveVoiceState.starting => CoreState.idle,
      };

  /// Starts a live conversation when the Qline voice is chosen and ready; false = use classic hands-free.
  Future<bool> _startLive() async {
    final p = ref.read(voicePrefsProvider);
    if (p.engine != 'qline') return false;
    final engine = PlatformLiveAudio.instance;
    final caps = await engine.capabilities();
    if (caps['supported'] == false || caps['recognizer'] == false) return false;
    if (!await _ensureStt()) return false; // asks for the microphone
    NeuralVoice? voice;
    try {
      voice = await QlineVoiceHub.instance.load(p.qlineModel, voice: p.qlineVoice, speed: neuralSpeed(p.rate));
    } catch (_) {}
    if (voice == null) {
      if (mounted) toast(context, 'Download the Qline voice in Settings → Voice for live conversation. Using classic hands-free.');
      return false;
    }
    try {
      _vad ??= await SileroDetector.create();
    } catch (_) {
      return false;
    }
    final locale = await _resolveLocale();
    if (_listening) await _stt.cancel();
    await _voice.stop();
    if (!mounted || !_handsFree) return false;
    final conv = LiveConversation(
      engine: engine,
      detector: _vad!,
      synth: voice,
      locale: locale?.replaceAll('_', '-'),
      aecRequested: p.echoCancel,
      inject: liveInjectWorks,
      bargeIn: p.bargeIn,
      onUtterance: (text, v) async {
        if (!mounted) return;
        if (_runId != null) await _liveCancel('');
        await _send(text, v);
      },
      onBargeIn: _liveCancel,
      onState: (s) {
        if (!mounted) return;
        setState(() {
          _liveState = s;
          _core = _coreFor(s);
          if (s != LiveVoiceState.userSpeaking && s != LiveVoiceState.interrupted) _level = 0;
        });
        if (s == LiveVoiceState.listening && _conv?.injecting == false) liveInjectWorks = false;
      },
      onCaption: (w) {
        if (mounted) setState(() => _input.text = w);
      },
      onLevel: (l) {
        if (_liveState != LiveVoiceState.userSpeaking && _liveState != LiveVoiceState.interrupted) return;
        final v = (l * 8).clamp(0.0, 1.0);
        liveLevel.value = v;
        if (mounted && (v - _level).abs() > .05) setState(() => _level = v);
      },
      onTimeline: liveTimings.add,
      onEnd: () {
        if (mounted) _setHandsFree(false);
      },
      onNotice: (m) {
        if (mounted) toast(context, m);
      },
    );
    _conv = conv;
    if (!await conv.start()) {
      _conv = null;
      return false;
    }
    return true;
  }

  /// The user talked over the reply (or pressed Stop): cancel the run, telling the server what was heard.
  Future<void> _liveCancel(String heard, {String reason = 'barge_in'}) async {
    final id = _runId;
    if (id == null) return;
    final f = _following;
    _following = null;
    await _sub?.cancel();
    _sub = null;
    _runId = null;
    if (mounted) {
      setState(() {
        f?.reply.streaming = false;
        f?.reply.interrupted = true;
        _busy = false;
      });
    }
    try {
      await _api.post('/runs/$id/cancel', {if (heard.isNotEmpty) 'heard': heard, 'reason': reason});
    } catch (_) {}
  }

  Future<void> _endLive() async {
    final c = _conv;
    if (c == null) return;
    _conv = null;
    await c.stop();
    if (mounted) setState(() => _liveState = LiveVoiceState.off);
  }

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
    _input.addListener(_onComposerChanged);
    WidgetsBinding.instance.addObserver(this);
    _init();
  }

  // ---- Background continuity ---------------------------------------------------------------------------
  bool _background = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.paused || s == AppLifecycleState.hidden) {
      _background = true;
      // Android stops the microphone for apps in the background; stop it cleanly (the answer and the
      // voice keep going while the app is alive).
      _relisten?.cancel();
      // A live conversation keeps going in the background (foreground service with an End button).
      if (_listening && _conv == null) {
        _barge = false;
        _gate.reset();
        _stt.cancel();
      }
    } else if (s == AppLifecycleState.resumed && _background) {
      _background = false;
      // The stream may have dropped while away: follow the answer from where it stopped.
      final f = _following;
      if (_runId != null && _sub == null && f != null) _follow(f);
      if (_handsFree && !_voice.speaking && _conv == null) _scheduleListen();
    }
  }

  /// Keeps the navbar orb in step with this screen.
  void _publish(String template) {
    final status = LiveStatus(core: _core, template: _liveTemplate ?? template, busy: _runId != null || _voice.speaking);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(liveStatusProvider.notifier).set(status);
    });
    if (_core != CoreState.speaking && !_listening) liveLevel.value = 0;
  }

  static final _stopPhrase = RegExp(r"^(please )?(stop listening|stop|that'?s all|goodbye|bye|end hands[- ]free|exit)[.!]?$", caseSensitive: false);

  Future<void> _speakReply(String text) async {
    final c = _conv;
    if (c != null) return c.sayLine(text);
    setState(() {
      _spoken = speakable(text);
      _word = -1;
      _core = CoreState.speaking;
    });
    await _voice.speak(_api, text, ref.read(voicePrefsProvider));
  }

  void _afterSpeech() {
    if (!mounted) return;
    final writing = _runId != null;
    setState(() {
      _speakLevel = 0;
      // Early spoken lines can finish before the written answer does: then it is still thinking.
      if (!writing) _busy = false;
      if (_core == CoreState.speaking) _core = writing ? CoreState.thinking : CoreState.idle;
    });
    liveLevel.value = 0;
    if (_barge) {
      // Speech ended without an interruption: the open microphone becomes normal listening, no restart.
      _barge = false;
      if (!writing && _listening) {
        _gate.reset();
        setState(() => _core = CoreState.listening);
        return;
      }
    }
    if (_handsFree && !writing) _scheduleListen();
  }

  // ---- Voice v2: barge-in ----------------------------------------------------------------------------
  /// Listening while the voice talks, to catch the user talking over it.
  bool _barge = false;

  /// A request heard while an answer was still being written; sent when it finishes.
  String? _queued;
  Map<String, dynamic>? _queuedVoice;

  void _startBargeIn() {
    final p = ref.read(voicePrefsProvider);
    if (!_handsFree || !p.bargeIn || _listening || _background) return;
    _listen(barge: true);
  }

  /// The user talked over the voice: stop it and keep listening to them.
  Future<void> _interrupt(String heard) async {
    final spoken = _spoken;
    _barge = false;
    _following?.voiceOn = false;
    await _voice.stop();
    if (!mounted) return;
    setState(() {
      _speakLevel = 0;
      _core = CoreState.listening;
      if (_runId == null) _busy = false;
    });
    _gate.reset();
    final said = withoutEcho(heard, spoken);
    if (said.isNotEmpty) _gate.feed(said);
  }

  void _scheduleListen([int ms = 250]) {
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
      if (await _startLive()) {
        if (mounted) toast(context, 'Live conversation is on. Talk any time, even while Qline speaks. Tap End to finish.');
        return;
      }
      if (!mounted || !_handsFree) return;
      if (mounted) toast(context, 'Hands-free is on. Talk any time; say "stop listening" to end.');
      _sttErrors = 0;
      if (!_busy && _runId == null) await _listen();
    } else {
      _relisten?.cancel();
      await _endLive();
      try {
        await WakelockPlus.disable();
      } catch (_) {}
      _barge = false;
      _queued = null;
      if (_listening) await _stt.stop();
      await _voice.stop();
      if (mounted) {
        setState(() {
          _busy = _runId != null;
          _spoken = '';
          if (_core == CoreState.listening || _core == CoreState.speaking) _core = CoreState.idle;
        });
      }
    }
  }

  /// Tap on the core: interrupt speech (and listen again in hands-free), or start/stop the mic.
  Future<void> _tapCore() async {
    final c = _conv;
    if (c != null) {
      // Live: tapping the core interrupts Qline the same way talking over it does.
      if (c.speaking || _runId != null) {
        final heard = await c.interruptNow();
        await _liveCancel(heard, reason: 'user');
      }
      return;
    }
    if (_core == CoreState.speaking && _voice.speaking) {
      if (_barge) {
        _barge = false;
        await _stt.cancel();
      }
      await _voice.stop();
      setState(() {
        _busy = _runId != null;
        _core = _runId != null ? CoreState.thinking : CoreState.idle;
        _speakLevel = 0;
      });
      if (_handsFree && _runId == null) await _listen();
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
      await _restoreDraft();
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

  // ---- Drafts (phase 3) --------------------------------------------------------------------------------
  Timer? _draftTimer;
  bool _restoring = false;

  String? _draftKey(String? conv) {
    final s = ref.read(sessionProvider);
    return s.orgId == null || s.email == null ? null : chatDraftKey(s.orgId!, s.email!, conv);
  }

  Future<void> _restoreDraft() async {
    final key = _draftKey(_convId);
    if (key == null) return;
    final text = await ref.read(chatPointerStoreProvider).read(key).catchError((Object _) => null);
    if (!mounted || text == null || text.isEmpty || _input.text.isNotEmpty) return;
    _restoring = true;
    _input.text = text;
    _input.selection = TextSelection.collapsed(offset: text.length);
    _restoring = false;
  }

  void _onComposerChanged() {
    if (_restoring) return;
    _draftTimer?.cancel();
    _draftTimer = Timer(const Duration(milliseconds: 600), _saveDraft);
  }

  void _saveDraft() {
    _draftTimer?.cancel();
    final key = _draftKey(_convId);
    if (key == null) return;
    final text = _input.text;
    final store = ref.read(chatPointerStoreProvider);
    (text.trim().isEmpty ? store.delete(key) : store.write(key, text.length > maxDraftChars ? text.substring(0, maxDraftChars) : text)).catchError((Object _) {});
  }

  void _clearDraft() {
    _draftTimer?.cancel();
    final key = _draftKey(_convId);
    if (key != null) ref.read(chatPointerStoreProvider).delete(key).catchError((Object _) {});
  }

  /// Before the composer moves to another conversation: keep what was typed here, then show that one's draft.
  void _leaveDraft() {
    _saveDraft();
    _restoring = true;
    _input.clear();
    _restoring = false;
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

  Future<void> _send([String? text, Map<String, dynamic>? voice]) async {
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
    _clearDraft();
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
        'voice': ?voice,
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
    final live = _conv != null && !resumed;
    if (live) _conv!.beginReply(runId);
    _follow(_Following(runId, reply, lastId: lastId, voiceOn: !live && !resumed && (_handsFree || ref.read(prefsProvider).speak), resumed: resumed, live: live));
  }

  /// The answer being followed, kept so a dropped connection can pick up where it stopped.
  _Following? _following;

  /// Subscribes to the run's events from [f.lastId]. A dropped connection reconnects (up to 4 times,
  /// with a short backoff) instead of failing: the server keeps writing the answer either way.
  void _follow(_Following f) {
    _following = f;
    final reply = f.reply;
    _sub?.cancel();
    _sub = _api.sse('/runs/${f.runId}/stream', lastEventId: f.lastId).listen(
      (e) {
        f.lastId = e.id ?? f.lastId;
        if (f.live && f.attempts > 0) _conv?.reconnecting(false);
        f.attempts = 0;
        final d = e.data;
        setState(() {
          switch (e.event) {
            case 'status':
              _core = d['state'] == 'thinking' && !_talking ? CoreState.thinking : _core;
            case 'token':
              reply.text += d['text'] as String? ?? '';
              if (f.live) {
                // v1.12: the spoken part is said while it streams; on-screen-only text ends it.
                if (d['say'] == true) {
                  _conv?.say(f.runId, d['text'] as String? ?? '');
                } else {
                  _conv?.closeSpeech(f.runId);
                }
              }
              // Writing is not speaking: the core only shows "speaking" while the voice is actually playing.
              if (!_talking) _core = CoreState.thinking;
            case 'speech':
              // Voice v2: a spoken line that arrived before the written answer finished; start talking now.
              final line = d['text'] as String? ?? '';
              if (f.voiceOn && line.isNotEmpty && !_background) {
                reply.spokeEarly = true;
                _voice.enqueue(_api, line, ref.read(voicePrefsProvider));
              } else if (f.voiceOn && line.isNotEmpty) {
                reply.spokeEarly = true; // in the background the line is not spoken; the notification says it's ready
              }
            case 'meta':
              reply.speech = d['speech'] as String?;
              reply.suggestions = ((d['suggestions'] as List?) ?? const []).whereType<String>().take(3).toList();
            case 'tool.planned':
              reply.steps!.add(TraceStep.planned(d));
              if (f.live) _conv?.closeSpeech(f.runId);
              if (!_talking) _core = CoreState.tool;
            case 'tool.result':
              final s = reply.steps!.where((s) => s.id == d['stepId']).lastOrNull ?? reply.steps!.lastOrNull;
              s?.result(d);
              if (!_talking) _core = CoreState.thinking;
            case 'artifact':
              if (reply.artifacts.length < 6) reply.artifacts.add(d);
            case 'approval.required':
              reply.approval = d;
              _core = CoreState.approval;
            case 'error':
              reply.error = d['message'] as String? ?? 'Something went wrong.';
              f.done = true; // a failed run ends with its error, not with "done"
              if (f.live) _conv?.replyDone(f.runId);
              _core = CoreState.error;
            case 'done':
              reply.streaming = false;
              f.done = true;
              if (f.live) _conv?.replyDone(f.runId, timing: (d['timing'] as Map?)?.cast<String, dynamic>());
              if (_core != CoreState.approval && _core != CoreState.error) _core = d['status'] == 'waiting_approval' ? CoreState.approval : (_talking ? CoreState.speaking : CoreState.success);
          }
        });
        _toBottom();
      },
      onError: (Object err) {
        _sub = null;
        final network = err is! ApiException || err.isNetwork;
        if (network && !f.done && f.attempts < 4 && mounted) {
          // Reconnect from the last event; in the background wait for the app to come back instead.
          f.attempts++;
          setState(() => _core = CoreState.offline);
          if (f.live) _conv?.reconnecting(true);
          if (_background) return;
          Future<void>.delayed(Duration(milliseconds: 600 * f.attempts), () {
            if (mounted && _following == f && _runId == f.runId && _sub == null && !_background) _follow(f);
          });
          return;
        }
        if (!mounted) return;
        setState(() {
          reply.streaming = false;
          reply.error = err is ApiException ? err.message : 'The connection dropped. The answer is still saved; reopen this conversation to see it.';
          _core = err is ApiException && !err.isNetwork ? CoreState.error : CoreState.offline;
          _runId = null;
          _busy = _talking;
        });
      },
      onDone: () async {
        _sub = null;
        if (!f.done && f.attempts < 4 && mounted && _runId == f.runId) {
          // The stream closed before "done" (a proxy timeout, a network change): follow it again.
          f.attempts++;
          if (!_background) {
            Future<void>.delayed(Duration(milliseconds: 400 * f.attempts), () {
              if (mounted && _following == f && _sub == null && !_background) _follow(f);
            });
          }
          return;
        }
        _following = null;
        _runId = null;
        reply.streaming = false;
        ref.read(refreshTick.notifier).bump();
        if (!mounted) return;
        if (reply.text.isEmpty && reply.artifacts.isEmpty && reply.error == null && reply.approval == null && (reply.steps?.isEmpty ?? true)) {
          setState(() => reply.error = 'No answer came back. Try again.');
        }
        if (f.live) {
          // v1.12: the live conversation already spoke the reply while it streamed.
          final c = _conv;
          if (c != null) {
            c.replyDone(f.runId);
            if (reply.approval != null) {
              c.sayLine('That needs your approval. I put it on the screen for you.');
            } else if (reply.error != null) {
              c.sayLine('Sorry, that did not work.');
            }
          }
          setState(() {
            _busy = false;
            if (_core == CoreState.success) _core = (c?.speaking ?? false) ? CoreState.speaking : CoreState.listening;
          });
          return;
        }
        if (_background && !f.resumed) {
          // Finished while Qline was in the background: say so in the notification shade.
          final body = reply.error ?? (reply.approval != null ? 'An action needs your approval.' : spokenLine(reply.speech, reply.text));
          showLocalAlert(id: f.runId.hashCode & 0x7fffffff, title: reply.approval != null ? 'Qline needs your approval' : 'Your answer is ready', body: body);
        }
        final voiceOn = f.voiceOn;
        final queued = _queued;
        if (queued != null) {
          // The user asked something new while this answer was being written: ask it now.
          final v = _queuedVoice;
          _queued = null;
          _queuedVoice = null;
          await _voice.stop();
          setState(() => _busy = false);
          await _send(queued, v);
          return;
        }
        if (reply.spokeEarly && (_core == CoreState.success || _core == CoreState.speaking)) {
          // The spoken line already played (or is still playing) while the text streamed.
          if (_voice.speaking) {
            setState(() => _core = CoreState.speaking);
          } else {
            setState(() => _core = CoreState.idle);
            _afterSpeech();
          }
        } else if (_core == CoreState.success) {
          if (voiceOn && reply.text.isNotEmpty && !_background) {
            // Speak the short spoken line, not the whole written answer.
            await _speakReply(spokenLine(reply.speech, reply.text));
          } else {
            await Future<void>.delayed(const Duration(milliseconds: 600));
            if (mounted && _core == CoreState.success) setState(() => _core = CoreState.idle);
            _afterSpeech();
          }
        } else if (_handsFree && _core == CoreState.approval && !_background) {
          await _speakReply('That needs your approval. I put it on the screen for you.');
        } else if (_handsFree && reply.error != null && !_background) {
          await _speakReply('Sorry, that did not work. ${reply.error}');
        } else {
          if (_core == CoreState.speaking && !_talking || _core == CoreState.thinking) setState(() => _core = CoreState.idle);
          _afterSpeech();
        }
        if (mounted) setState(() {});
      },
    );
  }

  Future<void> _cancel() async {
    final id = _runId;
    if (id == null) return;
    if (_conv != null) {
      final heard = await _conv!.interruptNow();
      await _liveCancel(heard, reason: 'user');
      if (mounted) setState(() => _msgs.add(_Msg('system_notice', 'Stopped.')));
      return;
    }
    _following = null;
    _queued = null;
    await _sub?.cancel();
    _sub = null;
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
          final barge = _barge;
          setState(() {
            _listening = false;
            _level = 0;
            if (_core == CoreState.listening) _core = CoreState.idle;
          });
          if (barge) {
            // The barge-in microphone timed out while the voice talks: open it again.
            _barge = false;
            if (_voice.speaking) Timer(const Duration(milliseconds: 300), _startBargeIn);
            return;
          }
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
        if (_barge) {
          _barge = false;
          return; // barge-in is best effort; the reply keeps playing
        }
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

  /// Voice v2: the recogniser locale for the chosen listening language (null = the phone's default).
  String? _localeId;
  String? _localeFor;

  Future<String?> _resolveLocale() async {
    final want = ref.read(voicePrefsProvider).listenLang;
    if (want == _localeFor) return _localeId;
    _localeFor = want;
    _localeId = null;
    if (want == 'auto') return null;
    try {
      final ids = (await _stt.locales()).map((l) => l.localeId);
      _localeId = pickLocale(want, ids);
    } catch (_) {}
    if (_localeId == null && mounted) toast(context, '${listenLangs[want]} speech recognition is not installed on this phone. Using the phone default.');
    return _localeId;
  }

  /// Recogniser details for the last heard request, sent with it so the model can read a misheard Taglish request.
  Map<String, dynamic>? _heardVoice;

  /// [barge]: listen while the voice is talking, only to notice the user talking over it.
  Future<void> _listen({bool barge = false}) async {
    if (!mounted || _listening || (!barge && _runId != null) || _conv != null) return;
    if (!await _ensureStt()) return;
    final locale = await _resolveLocale();
    if (!barge) await _voice.stop();
    if (!mounted) return;
    _heardVoice = null;
    _barge = barge;
    _gate
      ..reset()
      ..silence = Duration(milliseconds: _handsFree ? 1300 : 1100);
    setState(() {
      _listening = true;
      if (!barge) {
        _core = CoreState.listening;
        _spoken = '';
      }
    });
    await _stt.listen(
      onResult: (SpeechRecognitionResult r) {
        if (_barge) {
          if (_voice.speaking && isBargeIn(r.recognizedWords, _spoken)) _interrupt(r.recognizedWords);
          return;
        }
        if (_gate.committed) return;
        final words = _spokenEcho == null ? r.recognizedWords : withoutEcho(r.recognizedWords, _spokenEcho!);
        _heardVoice = {
          if (locale != null) 'lang': locale.replaceAll('_', '-'),
          if (r.hasConfidenceRating) 'confidence': double.parse(r.confidence.clamp(0, 1).toStringAsFixed(2)),
          if (r.alternates.length > 1) 'alternates': [for (final a in r.alternates.skip(1).take(3)) a.recognizedWords],
        };
        setState(() => _input.text = words);
        _gate.feed(words, isFinal: r.finalResult);
      },
      onSoundLevelChange: (l) {
        final v = ((l + 2) / 12).clamp(0, 1).toDouble();
        if (!_barge) {
          liveLevel.value = v;
          setState(() => _level = v);
        }
      },
      listenOptions: SpeechListenOptions(
        localeId: locale,
        partialResults: true,
        cancelOnError: true,
        listenMode: ListenMode.dictation,
        listenFor: Duration(seconds: _handsFree ? 60 : 30),
        // The recogniser's own pause must outlast the adaptive gate (max 2.6 s) so the gate decides.
        pauseFor: const Duration(milliseconds: 3000),
      ),
    );
  }

  /// After a barge-in, the same recognition session still holds the echo of what the voice said.
  String? get _spokenEcho => _spoken.isEmpty ? null : _spoken;

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
    final voice = {...?_heardVoice};
    _spoken = '';
    if (_runId != null) {
      // Heard while the answer is still being written (the user talked over an early spoken line).
      _queued = words;
      _queuedVoice = voice;
      _input.clear();
      toast(context, 'Got it. I\'ll ask that as soon as this answer finishes.');
      setState(() => _core = CoreState.thinking);
      return;
    }
    _send(words, voice);
  }

  /// New chat is always explicit: reopening the app continues the current conversation (M2).
  void _newChat() {
    _leaveDraft();
    _remember(newChatPointer);
    _sub?.cancel();
    _sub = null;
    _following = null;
    _queued = null;
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
    _restoreDraft();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _sub?.cancel();
    _conv?.stop();
    _stt.cancel();
    _relisten?.cancel();
    _gate.dispose();
    _voice.dispose();
    if (_handsFree) WakelockPlus.disable();
    if (_draftTimer?.isActive ?? false) _saveDraft();
    _input.removeListener(_onComposerChanged);
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
    _publish(template);
    final scaffold = _scaffold(context, q, prefs, aiOk, hasChat, template);
    // Background continuity: in the shell, Back and Close minimize (the shell handles Back); nothing is lost.
    if (widget.embedded) return scaffold;
    // Run 3 / M5: leaving the chat with an upload or an unsent message asks first. Nothing else is lost
    // (answers keep being written on the server; listening stops when the screen closes).
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop || _leaving) return;
        // Typed text is kept as a draft (phase 3); only attached files that were not sent would be lost.
        final unsent = _files.uploading ? 'A file is still uploading and will not be sent.' : (_pending.isNotEmpty ? 'The attached files were not sent and will be removed. Your text is kept as a draft.' : null);
        if (unsent != null) {
          _leaving = true;
          final ok = await confirm(context, title: 'Leave the chat?', body: unsent, action: 'Leave');
          _leaving = false;
          if (!ok || !context.mounted) return;
        }
        if (context.mounted) Navigator.of(context).pop();
      },
      child: scaffold,
    );
  }

  Widget _scaffold(BuildContext context, QColors q, Prefs prefs, bool aiOk, bool hasChat, String template) {
    return Scaffold(
      backgroundColor: QColors.liveInk,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        leading: widget.embedded
            ? IconButton(tooltip: 'Minimize', icon: const Icon(Icons.keyboard_arrow_down), onPressed: () => ref.read(liveHostProvider.notifier).minimize())
            : IconButton(tooltip: 'Close', icon: const Icon(Icons.close), onPressed: () => Navigator.maybePop(context)),
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
                  _leaveDraft();
                  await _loadConversation(id);
                  setState(() => _core = aiOk ? CoreState.idle : CoreState.error);
                  await _restoreDraft();
                } catch (e) {
                  if (context.mounted) toastError(context, e);
                }
              }
            },
          ),
          IconButton(tooltip: 'New chat', icon: const Icon(Icons.add_comment_outlined), onPressed: _runId == null ? _newChat : null),
          if (widget.embedded)
            IconButton(
              tooltip: 'End Live AI',
              icon: const Icon(Icons.close),
              onPressed: () async {
                if ((_runId != null || _voice.speaking || _handsFree) &&
                    !await confirm(context, title: 'End Live AI?', body: 'Listening and speech stop. An answer being written still finishes and is saved in this conversation.', action: 'End')) {
                  return;
                }
                ref.read(liveHostProvider.notifier).end();
              },
            ),
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
                      key: widget.coreKey,
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
          if (_handsFree) HandsFreeBar(listening: _listening, speaking: _core == CoreState.speaking, message: _conv != null ? liveMessage(_liveState) : null, onEnd: () => _setHandsFree(false)),
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
            child: Row(children: [AgentOrb(a['template'] as String?, size: 22, paused: a['status'] != 'active', accent: a['accent'] as String?), const SizedBox(width: 10), Text(a['name'] as String), if (a['status'] != 'active') Text('  · Paused', style: qs(12, c: q.text3))]),
          ),
      ],
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        auto ? const Icon(Icons.auto_awesome, size: 22) : AgentOrb(selected?['template'] as String?, size: 24, accent: selected?['accent'] as String?),
        const SizedBox(width: 10),
        Flexible(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(auto ? 'Auto' : selected?['name'] as String? ?? 'Assistant', overflow: TextOverflow.ellipsis, style: qs(15, w: FontWeight.w600, c: q.text)),
            Text(auto ? 'Picks the right agent' : (model == null ? (selected == null ? AgentStyle.of(null) : AgentStyle.ofAgent(selected!)).role : model!), overflow: TextOverflow.ellipsis, style: qs(11, c: q.text3, family: model == null || auto ? ui : mono)),
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
                Padding(padding: const EdgeInsets.only(top: 6), child: Consumer(
                  builder: (context, ref, _) => AttachmentChip(
                    name: a['name'] as String? ?? 'File',
                    kind: a['kind'] as String?,
                    size: a['size'] as num?,
                    onTap: a['id'] == null ? null : () => saveFileCopy(context, ref, a['id'] as String, a['name'] as String? ?? 'file'),
                  ),
                )),
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
  const HandsFreeBar({super.key, required this.listening, required this.speaking, required this.onEnd, this.message});
  final bool listening, speaking;

  /// v1.12: the live conversation's own status line.
  final String? message;
  final VoidCallback onEnd;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final msg = message ?? (speaking ? 'Hands-free · tap the core to interrupt' : (listening ? 'Hands-free · listening for you' : 'Hands-free · working…'));
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

/// v1.12: what the live conversation is doing, in words (docs/30 §9).
String liveMessage(LiveVoiceState s) => switch (s) {
      LiveVoiceState.listening => 'Live · listening',
      LiveVoiceState.userSpeaking => 'Live · hearing you',
      LiveVoiceState.thinking => 'Live · thinking',
      LiveVoiceState.speaking => 'Live · talk any time to interrupt',
      LiveVoiceState.interrupted => 'Live · interrupted, go ahead',
      LiveVoiceState.reconnecting => 'Live · reconnecting…',
      LiveVoiceState.error => 'Live · voice unavailable',
      LiveVoiceState.off || LiveVoiceState.starting => 'Live · starting…',
    };
