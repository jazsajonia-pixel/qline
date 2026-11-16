import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

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
          final engines = items(d, 'engines');
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
                    title: Row(children: [Flexible(child: Text(e['name'] as String)), if (e['id'] == 'gemini') ...[const SizedBox(width: 8), _Tag('Most natural · free tier')]]),
                    subtitle: Text(e['available'] == true ? (e['cost'] as String? ?? '') : 'Needs a key in AI providers', style: qs(13, c: e['available'] == true ? q.text2 : q.text3)),
                  ),
              ]),
            ),
            if (engines.any((e) => e['available'] != true)) Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => push(context, const AiProvidersScreen()).then((_) => reload()), icon: const Icon(Icons.key_outlined, size: 18), label: const Text('Add a key in AI providers'))),
            if (p.engine != 'device' && voices.isNotEmpty) ...[
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
            Text('Speed applies to the phone voice. Natural voices speak at their own pace.', style: qs(12, c: q.text3)),
            const SizedBox(height: 16),
            QButton(_playing ? 'Stop preview' : 'Preview voice', kind: QBtn.halo, icon: _playing ? Icons.stop : Icons.play_arrow, expand: true, onPressed: () => _preview(p)),
          ]);
        },
      ),
    );
  }
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
