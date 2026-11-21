import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/live_conversation.dart';
import '../core/neural_voice.dart';
import '../core/session.dart';
import '../core/voice.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'ai.dart';

const _sample = "Hi, I'm your Qline assistant. You have two new leads this morning, and one of them looks urgent.";

class VoiceSettingsScreen extends ConsumerStatefulWidget {
  const VoiceSettingsScreen({super.key});
  @override
  ConsumerState<VoiceSettingsScreen> createState() => _VoiceSettingsState();
}

class _VoiceSettingsState extends ConsumerState<VoiceSettingsScreen> {
  late final Speaker _speaker = Speaker(
    onWord: (_) {},
    onLevel: (_) {},
    onDone: () {
      if (mounted) setState(() => _playing = false);
    },
    onNotice: (m) {
      if (mounted) toast(context, m);
    },
  );
  bool _playing = false;
  List<Map<String, String>>? _device;

  @override
  void initState() {
    super.initState();
    _speaker.deviceVoices().then((v) {
      if (mounted) setState(() => _device = v);
    });
  }

  @override
  void dispose() {
    _speaker.dispose();
    super.dispose();
  }

  Future<void> _preview(VoicePrefs p) async {
    if (_playing) {
      await _speaker.stop();
      setState(() => _playing = false);
      return;
    }
    setState(() => _playing = true);
    await _speaker.speak(ref.read(apiProvider), _sample, p);
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final p = ref.watch(voicePrefsProvider);
    final prefs = ref.watch(prefsProvider);
    void setP(VoicePrefs n) => ref.read(voicePrefsProvider.notifier).set(n);
    return Page2(
      title: 'Voice',
      body: Load<Map<String, dynamic>>(
        fetch: (api) async => ((await api.get('/voice/options')) as Map).cast<String, dynamic>(),
        builder: (context, d, reload) {
          // v1.12: Qline's own on-device voice is offered by the app itself, not the server.
          final engines = [
            {'id': 'qline', 'name': 'Qline voice (on this phone)', 'available': true, 'cost': 'Free · works offline after a one-time download · live conversation'},
            ...items(d, 'engines'),
          ];
          final current = engines.where((e) => e['id'] == p.engine).firstOrNull;
          final voices = items(current, 'voices');
          return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
            SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Speak replies'), subtitle: const Text('Read AI answers aloud in Live. Hands-free mode always speaks.'), value: prefs.speak, onChanged: (v) => ref.read(prefsProvider.notifier).set(speak: v)),
            const SectionLabel('Voice engine'),
            RadioGroup<String>(
              groupValue: p.engine,
              onChanged: (v) {
                if (v == null) return;
                final e = engines.firstWhere((x) => x['id'] == v);
                if (e['available'] != true) {
                  toast(context, 'Add a ${v == 'gemini' ? 'Google Gemini' : 'OpenAI'} key in AI providers first.');
                  return;
                }
                setP(p.copy(engine: v, clearVoice: true));
              },
              child: Column(children: [
                for (final e in engines)
                  RadioListTile<String>(
                    contentPadding: EdgeInsets.zero,
                    value: e['id'] as String,
                    title: Row(children: [Flexible(child: Text(e['name'] as String)), if (e['id'] == 'qline') ...[const SizedBox(width: 8), const _Tag('Recommended')]]),
                    subtitle: Text(e['available'] == true ? (e['cost'] as String? ?? '') : 'Needs a key in AI providers', style: qs(13, c: e['available'] == true ? q.text2 : q.text3)),
                  ),
              ]),
            ),
            if (engines.any((e) => e['available'] != true)) Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => push(context, const AiProvidersScreen()).then((_) => reload()), icon: const Icon(Icons.key_outlined, size: 18), label: const Text('Add a key in AI providers'))),
            if (p.engine == 'qline') _QlineVoiceSection(prefs: p, onChanged: setP),
            if (p.engine != 'device' && p.engine != 'qline' && voices.isNotEmpty) ...[
              const SectionLabel('Voice'),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final v in voices) ChoiceChip(label: Text(v['label'] as String), selected: (p.voice ?? voices.first['id']) == v['id'], onSelected: (_) => setP(p.copy(voice: v['id'] as String))),
              ]),
              const SizedBox(height: 8),
              Text('If the natural voice is busy or out of free quota, Qline switches to the phone voice for that reply and tells you.', style: qs(12, c: q.text3)),
            ],
            if (p.engine == 'device') ...[
              const SectionLabel('Phone voice'),
              if (_device == null)
                const LinearProgressIndicator(minHeight: 2)
              else if (_device!.isEmpty)
                Text('No voices found. Install “Speech Recognition & Synthesis from Google” and download a voice in Android settings → Text-to-speech.', style: qs(13, c: q.text2))
              else
                DropdownButtonFormField<String>(
                  isExpanded: true,
                  initialValue: _device!.any((v) => v['name'] == p.deviceVoice?['name']) ? p.deviceVoice!['name'] : null,
                  hint: Text('Best available (${_device!.first['name']})', overflow: TextOverflow.ellipsis),
                  items: [for (final v in _device!.take(60)) DropdownMenuItem(value: v['name'], child: Text('${v['name']}  ·  ${v['locale']}', overflow: TextOverflow.ellipsis))],
                  onChanged: (n) => setP(p.copy(deviceVoice: _device!.firstWhere((v) => v['name'] == n))),
                ),
              const SizedBox(height: 6),
              Text('Voices with “network” in the name usually sound the most natural (they need internet).', style: qs(12, c: q.text3)),
            ],
            const SectionLabel('Speed'),
            Slider(value: p.rate, min: .3, max: .8, divisions: 10, label: p.rate == .5 ? 'Normal' : p.rate.toStringAsFixed(2), onChanged: (v) => setP(p.copy(rate: v))),
            Text('Speed applies to the Qline voice and the phone voice. Cloud voices speak at their own pace.', style: qs(12, c: q.text3)),
            const SectionLabel('Listening'),
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: p.listenLang,
              decoration: const InputDecoration(labelText: 'Language I speak'),
              items: [for (final e in listenLangs.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
              onChanged: (v) => setP(p.copy(listenLang: v)),
            ),
            const SizedBox(height: 6),
            Text('Taglish works in any of these; Qline reads mixed Filipino and English. Pick Filipino if names and words are often misheard. If the phone has no Filipino speech pack, it uses the phone default.', style: qs(12, c: q.text3)),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: p.bargeIn,
              onChanged: (v) => setP(p.copy(bargeIn: v)),
              title: Text('Interrupt by talking', style: qs(14, c: q.text)),
              subtitle: Text('In hands-free, talk over a reply to stop it and ask something else. Turn off if the speaker sets it off by itself.', style: qs(12, c: q.text3)),
            ),
            if (p.engine == 'qline')
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: p.echoCancel,
                onChanged: (v) => setP(p.copy(echoCancel: v)),
                title: Text('Echo cancellation', style: qs(14, c: q.text)),
                subtitle: Text('Uses the phone\'s call-style audio so Qline does not hear itself. Turn off if the voice sounds quiet or muffled; interrupting then needs you to speak up.', style: qs(12, c: q.text3)),
              ),
            const SizedBox(height: 16),
            QButton(_playing ? 'Stop preview' : 'Preview voice', kind: QBtn.halo, icon: _playing ? Icons.stop : Icons.play_arrow, expand: true, onPressed: () => _preview(p)),
          ]);
        },
      ),
    );
  }
}

/// v1.12 (docs/30): download, choose, test and benchmark Qline's on-device voice.
class _QlineVoiceSection extends StatefulWidget {
  const _QlineVoiceSection({required this.prefs, required this.onChanged});
  final VoicePrefs prefs;
  final void Function(VoicePrefs) onChanged;
  @override
  State<_QlineVoiceSection> createState() => _QlineVoiceSectionState();
}

class _QlineVoiceSectionState extends State<_QlineVoiceSection> {
  final _store = QlineVoiceHub.instance.store;
  final _installed = <String, bool>{};
  final _sizes = <String, int>{};
  String? _busy, _stage, _bench;
  double _progress = 0;
  bool _cancel = false, _testing = false;
  StreamSubscription<void>? _timings;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timings = liveTimings.changes.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _cancel = true;
    _timings?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    for (final m in voiceCatalog) {
      final ok = await _store.installedPath(m) != null;
      final size = ok ? await _store.sizeOnDisk(m) : 0;
      if (!mounted) return;
      setState(() {
        _installed[m.id] = ok;
        _sizes[m.id] = size;
      });
    }
  }

  VoiceModel get _model => voiceModelById(widget.prefs.qlineModel) ?? voiceCatalog.first;

  Future<void> _install(VoiceModel m) async {
    setState(() {
      _busy = m.id;
      _progress = 0;
      _stage = 'Starting…';
      _cancel = false;
    });
    try {
      await _store.install(m, cancelled: () => _cancel, onProgress: (v, stage) {
        if (mounted) {
          setState(() {
            _progress = v;
            _stage = stage;
          });
        }
      });
      widget.onChanged(widget.prefs.copy(engine: 'qline', qlineModel: m.id));
      if (mounted) toast(context, '${m.name} is ready. It works offline now.');
    } catch (e) {
      if (mounted && !_cancel) toast(context, 'Download failed: $e');
    } finally {
      if (mounted) setState(() => _busy = null);
      await _refresh();
    }
  }

  Future<void> _delete(VoiceModel m) async {
    final ok = await confirm(context, title: 'Delete ${m.name}?', body: 'This frees ${_mb(_sizes[m.id] ?? m.bytes)}. You can download it again later.', action: 'Delete', destructive: true);
    if (!ok) return;
    QlineVoiceHub.instance.unload();
    await _store.delete(m);
    await _refresh();
  }

  Future<void> _test() async {
    if (_testing) return;
    setState(() => _testing = true);
    try {
      final p = widget.prefs;
      final load = Stopwatch()..start();
      final v = await QlineVoiceHub.instance.load(_model.id, voice: p.qlineVoice, speed: neuralSpeed(p.rate));
      load.stop();
      if (v == null) throw StateError('Download the voice first.');
      {
        final lines = [_benchShort, _sample];
        final out = <String>['Load: ${load.elapsedMilliseconds} ms'];
        for (final t in lines) {
          final w = Stopwatch()..start();
          final a = await v.synth(t);
          w.stop();
          final rtf = a.durationMs == 0 ? 0 : w.elapsedMilliseconds / a.durationMs;
          out.add('${t.split(' ').length} words: ${w.elapsedMilliseconds} ms for ${(a.durationMs / 1000).toStringAsFixed(1)} s of speech (RTF ${rtf.toStringAsFixed(2)})');
        }
        if (mounted) setState(() => _bench = out.join('\n'));
      }
    } catch (e) {
      if (mounted) toast(context, '$e');
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final p = widget.prefs;
    final ready = _installed[_model.id] ?? false;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SectionLabel('Qline voice'),
      Text('A neural voice that runs inside Qline. Download it once (Wi-Fi recommended); after that it is free, private and works offline. English only for now: Filipino and Taglish words may sound wrong.', style: qs(12, c: q.text3)),
      const SizedBox(height: 8),
      for (final m in voiceCatalog)
        Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: m.id == _model.id ? q.halo : q.line)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(m.name, style: qs(14, w: FontWeight.w600, c: q.text))),
              if (m.id == _model.id && (_installed[m.id] ?? false)) const _Tag('In use'),
            ]),
            const SizedBox(height: 2),
            Text('${m.summary} ${_installed[m.id] == true ? 'On this phone · ${_mb(_sizes[m.id] ?? 0)}' : 'Download ${_mb(m.bytes)}'} · version ${m.version}', style: qs(12, c: q.text2)),
            const SizedBox(height: 4),
            InkWell(onTap: () => launchUrl(Uri.parse(m.licenseUrl), mode: LaunchMode.externalApplication), child: Text(m.license, style: qs(11, c: q.text3).copyWith(decoration: TextDecoration.underline))),
            if (_busy == m.id) ...[
              const SizedBox(height: 8),
              LinearProgressIndicator(value: _progress > 0 ? _progress : null, minHeight: 3),
              const SizedBox(height: 4),
              Row(children: [Expanded(child: Text(_stage ?? '', style: qs(12, c: q.text2))), TextButton(onPressed: () => setState(() => _cancel = true), child: const Text('Cancel'))]),
            ] else
              Wrap(spacing: 8, children: [
                if (_installed[m.id] != true) TextButton.icon(onPressed: _busy == null ? () => _install(m) : null, icon: const Icon(Icons.download, size: 18), label: const Text('Download')),
                if (_installed[m.id] == true && m.id != _model.id) TextButton(onPressed: () => widget.onChanged(p.copy(qlineModel: m.id)), child: const Text('Use')),
                if (_installed[m.id] == true) TextButton(onPressed: () => _delete(m), child: const Text('Delete')),
              ]),
          ]),
        ),
      if (ready) ...[
        const SectionLabel('Speaker'),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (var i = 0; i < _model.voices.length; i++) ChoiceChip(label: Text(_model.voices[i]), selected: (p.qlineVoice ?? _model.defaultVoice) == i, onSelected: (_) => widget.onChanged(p.copy(qlineVoice: i))),
        ]),
        const SizedBox(height: 8),
        Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: _testing ? null : _test, icon: const Icon(Icons.speed, size: 18), label: Text(_testing ? 'Measuring…' : 'Benchmark this phone'))),
        if (_bench != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_bench!, style: qs(12, c: q.text2))),
        const SizedBox(height: 4),
        Text('RTF below 1 means it speaks faster than real time. Live replies start after the first short phrase is ready.', style: qs(11, c: q.text3)),
      ],
      if (liveTimings.items.isNotEmpty) ...[
        const SectionLabel('Last live conversation'),
        for (final t in liveTimings.items.take(6)) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(describeTimeline(t), style: qs(12, c: q.text2))),
      ],
    ]);
  }
}

const _benchShort = 'Sure, here is your schedule.';

String _mb(int bytes) => '${(bytes / 1048576).toStringAsFixed(0)} MB';

/// One line per measured turn or interruption (docs/30 §8). Missing steps are left out, not guessed.
String describeTimeline(VoiceTimeline t) {
  String ms(int? v) => v == null ? '–' : '$v ms';
  if (t.kind == 'barge') {
    return 'Interruption${t.falseAlarm ? ' (false alarm, resumed)' : ''}: voice stopped in ${ms(t.between('detect', 'stopped'))}, '
        'cancel confirmed in ${ms(t.between('detect', 'cancelled'))}, next reply audible after ${ms(t.between('detect', 'nextAudio'))}';
  }
  final s = t.server;
  return 'Turn: you finished → heard Qline in ${ms(t.between('endpoint', 'audio'))} · '
      'AI first words ${ms(t.between('sent', 'firstSay'))}${s?['firstTokenMs'] != null ? ' (server ${s!['firstTokenMs']} ms)' : ''} · '
      'first chunk voiced in ${ms(t.between('synthStart', 'synthDone'))} · gaps ${t.gaps}${t.gapMs > 0 ? ' (${t.gapMs} ms)' : ''}';
}

class _Tag extends StatelessWidget {
  const _Tag(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(6), color: q.halo.withValues(alpha: .12)),
      child: Text(text, style: qs(11, w: FontWeight.w600, c: q.halo)),
    );
  }
}
