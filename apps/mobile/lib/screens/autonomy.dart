import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../ui/theme.dart';
import '../ui/widgets.dart';

/// v1.6: how much the AI may do on its own. Owners and admins choose; agents can never change it.
class AutonomyScreen extends ConsumerWidget {
  const AutonomyScreen({super.key});

  static const levels = [
    ('supervised', 'Supervised', 'The AI asks before it changes your data or acts in connected apps. Safest.', Icons.verified_user_outlined),
    ('autopilot', 'Autopilot', 'The AI updates tasks, contacts, companies and projects and hands work to other agents on its own. Deleting records, setup changes and actions in Slack or email still ask first.', Icons.bolt_outlined),
    ('full', 'Full autopilot', 'Also posts in Slack, creates Slack channels, sends email and deletes records without asking, up to a daily limit. Setup changes still ask first.', Icons.rocket_launch_outlined),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Page2(
      title: 'AI autonomy',
      body: Load<Map<String, dynamic>>(
        fetch: (api) async {
          final ws = ((await api.get('/missions')) as Map)['controls']?['workspaceId'] as String?;
          final a = ((await api.get('/workspaces/$ws/autonomy')) as Map).cast<String, dynamic>();
          return {...a, 'ws': ws};
        },
        builder: (context, d, reload) {
          final q = context.q;
          final level = d['autonomy'] as String? ?? 'supervised';
          final can = d['canChange'] == true;
          final limit = (d['dailyExternalLimit'] as num?)?.toInt() ?? 25;
          Future<void> save(Map<String, Object> change, String ok) async {
            await act(context, ref, (api) => api.put('/workspaces/${d['ws']}/autonomy', {'autonomy': level, ...change}), ok: ok);
            await reload();
          }

          return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
            Text('Choose how much the AI can do without asking you. Every action is still recorded in the audit log, and the emergency stop in Missions halts everything.', style: qs(14, c: q.text2, h: 1.45)),
            if (!can) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Only an owner or admin can change this.', style: qs(13, c: q.warn))),
            const SizedBox(height: 12),
            RadioGroup<String>(
              groupValue: level,
              onChanged: (v) async {
                if (v == null || v == level || !can) return;
                if (v == 'full') {
                  final ok = await confirm(context,
                      title: 'Turn on full autopilot?',
                      body: 'The AI will post in Slack, create channels, send email and delete records without asking — up to $limit actions in connected apps per day. You can switch back at any time.',
                      action: 'Turn on');
                  if (!ok) return;
                }
                if (!context.mounted) return;
                await act(context, ref, (api) => api.put('/workspaces/${d['ws']}/autonomy', {'autonomy': v}), ok: 'Autonomy updated');
                await reload();
              },
              child: Column(children: [
                for (final (id, name, help, icon) in levels)
                  QCard(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: RadioListTile<String>(
                      value: id,
                      enabled: can,
                      secondary: Icon(icon),
                      title: Text(name, style: qs(15, w: FontWeight.w600, c: q.text)),
                      subtitle: Text(help, style: qs(13, c: q.text2, h: 1.4)),
                    ),
                  ),
              ].expand((w) => [w, const SizedBox(height: 8)]).toList()),
            ),
            if (level == 'full') ...[
              const SectionLabel('Daily limit for connected apps'),
              Text('${d['externalToday'] ?? 0} of $limit used in the last 24 hours. When the limit is reached, the AI asks again.', style: qs(13, c: q.text2)),
              _LimitSlider(initial: limit, enabled: can, onDone: (v) => save({'dailyExternalLimit': v}, 'Limit set to $v')),
            ],
            const SectionLabel('Never automatic'),
            Text('Moving money, changing roles or permissions, deleting the organisation, and sharing data outside Qline are never done by the AI at any level.', style: qs(13, c: q.text2, h: 1.4)),
          ]);
        },
      ),
    );
  }
}

class _LimitSlider extends StatefulWidget {
  const _LimitSlider({required this.initial, required this.enabled, required this.onDone});
  final int initial;
  final bool enabled;
  final ValueChanged<int> onDone;
  @override
  State<_LimitSlider> createState() => _LimitSliderState();
}

class _LimitSliderState extends State<_LimitSlider> {
  late double _v = widget.initial.clamp(0, 100).toDouble();
  @override
  Widget build(BuildContext context) => Slider(
        value: _v,
        min: 0,
        max: 100,
        divisions: 20,
        label: '${_v.round()}',
        onChanged: widget.enabled ? (v) => setState(() => _v = v) : null,
        onChangeEnd: widget.enabled ? (v) => widget.onDone(v.round()) : null,
      );
}
