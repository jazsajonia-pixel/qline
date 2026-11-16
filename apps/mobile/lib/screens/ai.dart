import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

/// Short label for an assignment, e.g. "Anthropic · claude-x".
String modelLabel(Map? a, [List<Map<String, dynamic>> providers = const []]) {
  if (a == null || a['provider'] == null) return 'Not set';
  final p = providers.where((p) => p['id'] == a['provider']).firstOrNull;
  return '${p?['name'] ?? cap(a['provider'] as String)} · ${a['model']}';
}

/// Settings → AI providers. Owners and admins choose which providers to connect;
/// nothing is required, and keys are never shown again after saving.
class AiProvidersScreen extends ConsumerWidget {
  const AiProvidersScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Page2(
      title: 'AI providers',
      body: Load<Map>(
        fetch: (api) async => await api.get('/ai/overview') as Map,
        builder: (context, o, reload) {
          final providers = items(o, 'providers');
          final canManage = o['canManage'] == true;
          final connected = providers.where((p) => p['connected'] == true).toList();
          final def = o['default'] as Map?;
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.all(16), children: [
              Text(
                'Connect only the providers you want. Qline uses your own API keys, so usage is billed by the provider to your account. Keys are encrypted on the server and never shown again.',
                style: qs(14, c: q.text2, h: 1.45),
              ),
              if (!canManage) ...[
                const SizedBox(height: 10),
                Text('Only owners and admins can add or remove keys.', style: qs(13, c: q.text3)),
              ],
              const SectionLabel('Workspace default'),
              QCard(
                child: Row(children: [
                  Icon(def == null ? Icons.radio_button_unchecked : Icons.check_circle_outline, color: def == null ? q.text3 : q.ok, size: 20),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(def == null ? 'No default model yet' : modelLabel(def, providers), style: qs(15, w: FontWeight.w600, c: q.text)),
                      const SizedBox(height: 2),
                      Text(
                        connected.isEmpty ? 'Connect a provider first.' : 'Used by agents that don\'t have their own model.',
                        style: qs(12, c: q.text3),
                      ),
                    ]),
                  ),
                  if (canManage && connected.isNotEmpty)
                    QButton(def == null ? 'Choose' : 'Change', onPressed: () async {
                      final pick = await pickModel(context, ref, providers: providers, current: def);
                      if (pick != null && context.mounted) {
                        await act(context, ref, (api) => api.put('/ai/default', pick), ok: 'Default model saved');
                        await reload();
                      }
                    }),
                ]),
              ),
              const SectionLabel('Providers'),
              for (final p in providers) ...[
                _ProviderCard(p: p, canManage: canManage, reload: reload, hasDefault: def != null, providers: providers),
                const SizedBox(height: 10),
              ],
            ]),
          );
        },
      ),
    );
  }
}

class _ProviderCard extends ConsumerWidget {
  const _ProviderCard({required this.p, required this.canManage, required this.reload, required this.hasDefault, required this.providers});
  final Map<String, dynamic> p;
  final bool canManage;
  final bool hasDefault;
  final Future<void> Function() reload;
  final List<Map<String, dynamic>> providers;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final connected = p['connected'] == true;
    final invalid = p['status'] == 'invalid';
    final id = p['id'] as String;
    return QCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p['name'] as String, style: qs(16, w: FontWeight.w600, c: q.text)),
              Text(p['maker'] as String? ?? '', style: qs(12, c: q.text3)),
            ]),
          ),
          _Chip(
            label: invalid ? 'Key rejected' : connected ? 'Connected' : 'Not connected',
            color: invalid ? q.bad : connected ? q.ok : q.text3,
          ),
        ]),
        const SizedBox(height: 8),
        if (connected)
          Text('Key ending ${p['keyHint']} · ${p['modelCount']} models${p['checkedAt'] != null ? ' · checked ${ago(p['checkedAt'] as String?)}' : ''}', style: qs(12, c: q.text2, family: mono)),
        if (invalid && p['statusDetail'] != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(p['statusDetail'] as String, style: qs(12, c: q.bad))),
        if (!connected) Text(p['costNote'] as String? ?? '', style: qs(13, c: q.text2, h: 1.4)),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (canManage && !connected)
            QButton('Add key', icon: Icons.key_outlined, onPressed: () async {
              final ok = await showKeySheet(context, ref, p);
              if (ok == true) {
                await reload();
                if (!hasDefault && context.mounted) {
                  final pick = await pickModel(context, ref, providers: providers, onlyProvider: id, title: 'Pick a default model');
                  if (pick != null && context.mounted) {
                    await act(context, ref, (api) => api.put('/ai/default', pick), ok: 'Default model saved');
                    await reload();
                  }
                }
              }
            }),
          if (!connected)
            QButton('Get a key', kind: QBtn.ghost, icon: Icons.open_in_new, onPressed: () => launchUrl(Uri.parse(p['keyUrl'] as String), mode: LaunchMode.externalApplication)),
          if (connected && canManage)
            QButton('Test', icon: Icons.play_arrow_outlined, onPressed: () async {
              final pick = await pickModel(context, ref, providers: providers, onlyProvider: id, title: 'Test which model?');
              if (pick != null && context.mounted) await _runTest(context, ref, id, pick['model'] as String);
            }),
          if (connected && canManage)
            QButton('Refresh models', kind: QBtn.ghost, icon: Icons.refresh, onPressed: () async {
              final r = await act(context, ref, (api) => api.get('/ai/providers/$id/models', {'refresh': '1'}));
              if (r != null && context.mounted) toast(context, '${items(r).length} models');
              await reload();
            }),
          if (connected && canManage)
            QButton('Replace key', kind: QBtn.ghost, icon: Icons.key_outlined, onPressed: () async {
              if (await showKeySheet(context, ref, p) == true) await reload();
            }),
          if (connected && canManage)
            QButton('Remove', kind: QBtn.ghost, icon: Icons.delete_outline, onPressed: () async {
              if (await confirm(context, title: 'Remove ${p['name']}?', body: 'The key is deleted from Qline. Agents set to ${p['name']} will stop answering until you pick another model.', action: 'Remove', destructive: true)) {
                if (context.mounted) await act(context, ref, (api) => api.delete('/ai/providers/$id'), ok: 'Removed');
                await reload();
              }
            }),
        ]),
      ]),
    );
  }
}

Future<void> _runTest(BuildContext context, WidgetRef ref, String provider, String model) async {
  showDialog(context: context, barrierDismissible: false, builder: (_) => const AlertDialog(content: Row(children: [SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)), SizedBox(width: 16), Text('Asking the model…')])));
  Map? r;
  Object? err;
  try {
    r = await ref.read(apiProvider).post('/ai/providers/$provider/test', {'model': model}) as Map;
  } catch (e) {
    err = e;
  }
  if (!context.mounted) return;
  Navigator.of(context).pop();
  final ok = r?['ok'] == true;
  await showDialog(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(ok ? 'It works' : 'Test failed', style: qs(18, w: FontWeight.w600, c: ctx.q.text)),
      content: Text(
        ok
            ? '$model replied: "${(r!['reply'] as String?)?.isNotEmpty == true ? r['reply'] : '(empty reply)'}"\n${r['latencyMs']} ms · ${r['inputTokens']} in / ${r['outputTokens']} out tokens'
            : err is ApiException
                ? err.message
                : (r?['message'] as String? ?? 'Something went wrong.'),
        style: qs(14, c: ctx.q.text2, h: 1.4),
      ),
      actions: [QButton('Done', onPressed: () => Navigator.pop(ctx))],
    ),
  );
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.color});
  final String label;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(99), border: Border.all(color: color.withValues(alpha: .6))),
        child: Text(label, style: qs(12, w: FontWeight.w600, c: color)),
      );
}

/// Paste-a-key sheet. Returns true when the key was validated and saved.
Future<bool?> showKeySheet(BuildContext context, WidgetRef ref, Map<String, dynamic> p) {
  return showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (ctx) => _KeySheet(p: p));
}

class _KeySheet extends ConsumerStatefulWidget {
  const _KeySheet({required this.p});
  final Map<String, dynamic> p;
  @override
  ConsumerState<_KeySheet> createState() => _KeySheetState();
}

class _KeySheetState extends ConsumerState<_KeySheet> {
  final _c = TextEditingController();
  bool _hidden = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final key = _c.text.trim();
    if (key.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await ref.read(apiProvider).put('/ai/providers/${widget.p['id']}', {'apiKey': key}) as Map;
      if (!mounted) return;
      ref.read(refreshTick.notifier).bump();
      toast(context, '${widget.p['name']} connected · ${r['modelCount']} models');
      Navigator.pop(context, true);
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e is ApiException ? (e.code == 'AI_KEY_REJECTED' ? '${e.title}. ${e.detail ?? ''}' : e.message) : 'Something went wrong.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final p = widget.p;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${p['name']} API key', style: qs(18, w: FontWeight.w600, c: q.text)),
        const SizedBox(height: 6),
        Text(p['costNote'] as String? ?? '', style: qs(13, c: q.text2, h: 1.4)),
        const SizedBox(height: 14),
        TextField(
          controller: _c,
          autofocus: true,
          obscureText: _hidden,
          enableSuggestions: false,
          autocorrect: false,
          style: qs(14, c: q.text, family: mono),
          decoration: InputDecoration(
            labelText: 'Paste key',
            hintText: p['keyPrefix'] != null ? '${p['keyPrefix']}…' : null,
            errorText: _error,
            errorMaxLines: 4,
            suffixIcon: IconButton(tooltip: _hidden ? 'Show key' : 'Hide key', icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _hidden = !_hidden)),
          ),
          onSubmitted: (_) => _save(),
        ),
        const SizedBox(height: 8),
        Text('Qline checks the key with ${p['name']} before saving it.', style: qs(12, c: q.text3)),
        const SizedBox(height: 14),
        Row(children: [
          QButton('Get a key', kind: QBtn.ghost, icon: Icons.open_in_new, onPressed: () => launchUrl(Uri.parse(p['keyUrl'] as String), mode: LaunchMode.externalApplication)),
          const Spacer(),
          QButton('Save key', kind: QBtn.halo, busy: _busy, onPressed: _busy ? null : _save),
        ]),
      ]),
    );
  }
}

/// Model picker across connected providers. Returns {provider, model}, or {provider: null}
/// when [allowDefault] is set and the user chose "Use workspace default".
Future<Map<String, dynamic>?> pickModel(
  BuildContext context,
  WidgetRef ref, {
  required List<Map<String, dynamic>> providers,
  Map? current,
  String? onlyProvider,
  bool allowDefault = false,
  String title = 'Choose a model',
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => _ModelSheet(providers: providers, current: current, onlyProvider: onlyProvider, allowDefault: allowDefault, title: title),
  );
}

class _ModelSheet extends ConsumerStatefulWidget {
  const _ModelSheet({required this.providers, this.current, this.onlyProvider, required this.allowDefault, required this.title});
  final List<Map<String, dynamic>> providers;
  final Map? current;
  final String? onlyProvider;
  final bool allowDefault;
  final String title;
  @override
  ConsumerState<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends ConsumerState<_ModelSheet> {
  late final List<Map<String, dynamic>> _connected =
      widget.providers.where((p) => p['connected'] == true && (widget.onlyProvider == null || p['id'] == widget.onlyProvider)).toList();
  late String? _provider = (_connected.any((p) => p['id'] == widget.current?['provider']) ? widget.current!['provider'] as String : _connected.firstOrNull?['id'] as String?);
  final Map<String, List<Map<String, dynamic>>> _models = {};
  String _q = '';
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final id = _provider;
    if (id == null || _models.containsKey(id)) return;
    try {
      final r = await ref.read(apiProvider).get('/ai/providers/$id/models');
      if (mounted) setState(() => _models[id] = items(r));
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final list = (_models[_provider] ?? const []).where((m) => _q.isEmpty || (m['id'] as String).toLowerCase().contains(_q) || (m['name'] as String? ?? '').toLowerCase().contains(_q)).toList();
    final loading = _provider != null && !_models.containsKey(_provider) && _error == null;
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * .8,
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 4, 16, MediaQuery.viewInsetsOf(context).bottom),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.title, style: qs(18, w: FontWeight.w600, c: q.text)),
          const SizedBox(height: 10),
          if (widget.allowDefault)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(widget.current?['provider'] == null ? Icons.radio_button_checked : Icons.radio_button_unchecked, color: q.halo),
              title: const Text('Use workspace default'),
              subtitle: const Text('Follows Settings → AI providers'),
              onTap: () => Navigator.pop(context, <String, dynamic>{'provider': null}),
            ),
          if (_connected.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: Text('No provider is connected yet. Add a key in Settings → AI providers.', style: qs(14, c: q.text2)))
          else ...[
            if (_connected.length > 1)
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [
                  for (final p in _connected)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(p['name'] as String),
                        selected: _provider == p['id'],
                        onSelected: (_) {
                          setState(() {
                            _provider = p['id'] as String;
                            _error = null;
                          });
                          _load();
                        },
                      ),
                    ),
                ]),
              ),
            const SizedBox(height: 8),
            TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search models'), onChanged: (v) => setState(() => _q = v.trim().toLowerCase())),
            const SizedBox(height: 4),
            Expanded(
              child: _error != null
                  ? ErrorPanel(_error!)
                  : loading
                      ? const SkeletonList()
                      : list.isEmpty
                          ? Center(child: Text('No models match.', style: qs(14, c: q.text3)))
                          : ListView.builder(
                              itemCount: list.length,
                              itemBuilder: (_, i) {
                                final m = list[i];
                                final selected = widget.current?['provider'] == _provider && widget.current?['model'] == m['id'];
                                final name = m['name'] as String? ?? '';
                                return ListTile(
                                  contentPadding: EdgeInsets.zero,
                                  dense: true,
                                  leading: Icon(selected ? Icons.radio_button_checked : Icons.radio_button_unchecked, color: selected ? q.halo : q.text3, size: 20),
                                  title: Text(m['id'] as String, style: qs(14, c: q.text, family: mono)),
                                  subtitle: name.isNotEmpty && name != m['id'] ? Text(name, style: qs(12, c: q.text3)) : null,
                                  onTap: () => Navigator.pop(context, <String, dynamic>{'provider': _provider, 'model': m['id']}),
                                );
                              },
                            ),
            ),
          ],
        ]),
      ),
    );
  }
}

/// "AI model" row for an agent: shows its own model or the workspace default, and lets
/// managers change it.
class AgentModelCard extends ConsumerWidget {
  const AgentModelCard({super.key, required this.agentId, required this.canManage});
  final String agentId;
  final bool canManage;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Load<Map>(
      skeleton: const SizedBox(height: 72),
      fetch: (api) async => await api.get('/ai/overview') as Map,
      builder: (context, o, reload) {
        final providers = items(o, 'providers');
        final a = items(o, 'agents').where((x) => x['id'] == agentId).firstOrNull ?? {};
        final own = a['assignment'] as Map?;
        final eff = a['effective'] as Map?;
        final ready = a['ready'] == true;
        return QCard(
          child: Row(children: [
            Icon(ready ? Icons.memory : Icons.warning_amber_outlined, color: ready ? q.text2 : q.warn, size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(eff == null ? 'No model set' : modelLabel(eff, providers), style: qs(14, w: FontWeight.w600, c: q.text, family: mono)),
                const SizedBox(height: 2),
                Text(
                  !ready
                      ? (eff == null ? 'Add a provider key in Settings → AI providers.' : 'That provider isn\'t connected. Pick another model.')
                      : own == null
                          ? 'Workspace default'
                          : 'Set for this agent',
                  style: qs(12, c: ready ? q.text3 : q.warn),
                ),
              ]),
            ),
            if (canManage)
              QButton('Change', onPressed: () async {
                if (!providers.any((p) => p['connected'] == true)) {
                  push(context, const AiProvidersScreen());
                  return;
                }
                final pick = await pickModel(context, ref, providers: providers, current: own, allowDefault: true, title: 'Model for ${a['name'] ?? 'this agent'}');
                if (pick != null && context.mounted) {
                  await act(context, ref, (api) => api.put('/agents/$agentId/model', pick), ok: 'Saved as a new version');
                  await reload();
                }
              }),
          ]),
        );
      },
    );
  }
}
