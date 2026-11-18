import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'leads.dart';

Map<String, dynamic> _m(dynamic v) => (v as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

const _icons = {'google': Icons.mail_outline, 'microsoft': Icons.window_outlined, 'slack': Icons.tag, 'notion': Icons.article_outlined, 'github': Icons.code, 'stripe': Icons.payments_outlined};

/// Providers that sync leads on a schedule (the others are used by the AI on demand).
const syncingProviders = {'google', 'microsoft'};

Future<void> _open(BuildContext context, String? url) async {
  if (url == null) return;
  final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) toast(context, 'Could not open the browser.');
}

/// Each user signs in with their own Google / Microsoft / Slack account. Tokens are sealed on the server.
class IntegrationsScreen extends ConsumerStatefulWidget {
  const IntegrationsScreen({super.key});
  @override
  ConsumerState<IntegrationsScreen> createState() => _IntegrationsState();
}

class _IntegrationsState extends ConsumerState<IntegrationsScreen> with WidgetsBindingObserver {
  Map<String, dynamic>? _data;
  Object? _error;
  bool _awaitingLogin = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // Coming back from the browser login (qline://integrations) → refresh.
    if (s == AppLifecycleState.resumed && _awaitingLogin) {
      _awaitingLogin = false;
      _load(announce: true);
    }
  }

  Future<void> _load({bool announce = false}) async {
    final before = _connectedIds();
    try {
      final d = _m(await ref.read(apiProvider).get('/integrations'));
      if (!mounted) return;
      setState(() {
        _data = d;
        _error = null;
      });
      final now = _connectedIds();
      if (announce && now.length > before.length) toast(context, 'Connected');
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Set<String> _connectedIds() => items(_data, 'providers').where((p) => p['connection'] != null).map((p) => p['id'] as String).toSet();

  Future<void> _connect(Map<String, dynamic> p, {List<String>? only}) async {
    if (p['auth'] == 'key') {
      final ok = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const StripeKeySheet());
      if (ok == true && mounted) {
        toast(context, 'Stripe connected');
        await _load();
      }
      return;
    }
    final features = items(p, 'features');
    final picked = only ?? await showModalBottomSheet<List<String>>(context: context, isScrollControlled: true, builder: (_) => _ConnectSheet(provider: p, features: features));
    if (picked == null || !mounted) return;
    final r = await act(context, ref, (api) => api.post('/integrations/${p['id']}/connect', {'features': picked}));
    if (r == null || !mounted) return;
    _awaitingLogin = true;
    await _open(context, _m(r)['url'] as String?);
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    final d = _data;
    return Page2(
      title: 'Integrations',
      actions: [
        if (d?['canSetup'] == true) IconButton(tooltip: 'Integration setup (app owner)', icon: const Icon(Icons.admin_panel_settings_outlined), onPressed: () => push(context, const IntegrationSetupScreen()).then((_) => _load())),
      ],
      body: d == null
          ? (_error != null ? ErrorPanel(_error!, onRetry: _load) : const SkeletonList())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
                Text('Sign in with your own accounts. Qline only asks for what each feature needs, and you can disconnect any time.', style: qs(14, c: q.text2, h: 1.45)),
                if (!s.canManage) Padding(padding: const EdgeInsets.only(top: 12), child: _Note(icon: Icons.lock_outline, text: 'Only owners and admins can connect or change integrations.')),
                if (d['canSetup'] == true && items(d, 'providers').any((p) => p['registered'] != true))
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: QCard(
                      accent: q.halo.withValues(alpha: .5),
                      onTap: () => push(context, const IntegrationSetupScreen()).then((_) => _load()),
                      child: Row(children: [
                        Icon(Icons.admin_panel_settings_outlined, color: q.halo),
                        const SizedBox(width: 12),
                        Expanded(child: Text('You own this Qline server. Enter the client ID and secret for each provider you registered so everyone can sign in.', style: qs(13, c: q.text, h: 1.4))),
                        Icon(Icons.chevron_right, color: q.text3),
                      ]),
                    ),
                  ),
                const SectionLabel('Accounts'),
                for (final (i, p) in items(d, 'providers').indexed)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Reveal(
                      index: i,
                      child: _ProviderCard(
                        p: p,
                        canManage: s.canManage,
                        onConnect: () => _connect(p),
                        onOpen: () => push(context, ConnectionScreen(provider: p, onReconnect: (f) => _connect(p, only: f))).then((_) => _load()),
                      ),
                    ),
                  ),
                if (items(d, 'providers').any((p) => p['id'] == 'google'))
                  _Note(icon: Icons.info_outline, text: 'Google lets an app in “Testing” mode connect only listed test accounts, and those logins expire after 7 days. Qline will tell you when to reconnect. Gmail reading and Drive reading for everyone need Google verification.'),
                const SectionLabel('Also in Qline'),
                for (final o in items(d, 'other'))
                  ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                    title: Text(o['name'] as String),
                    subtitle: Text(o['detail'] as String? ?? ''),
                    trailing: StatusPill(o['status'] == 'available' ? 'active' : 'planned'),
                  ),
              ]),
            ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Container(
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: q.surface2, borderRadius: BorderRadius.circular(12), border: Border.all(color: q.line)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(icon, size: 18, color: q.text2), const SizedBox(width: 10), Expanded(child: Text(text, style: qs(13, c: q.text2, h: 1.4)))]),
    );
  }
}

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.p, required this.canManage, required this.onConnect, required this.onOpen});
  final Map<String, dynamic> p;
  final bool canManage;
  final VoidCallback onConnect, onOpen;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final conn = p['connection'] == null ? null : _m(p['connection']);
    final registered = p['registered'] == true;
    final feats = items(p, 'features');
    final on = (conn?['features'] as List?)?.cast<String>() ?? const [];
    return QCard(
      onTap: conn != null ? onOpen : null,
      accent: conn != null && conn['status'] != 'ok' ? q.warn.withValues(alpha: .6) : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: q.halo.withValues(alpha: conn != null ? .14 : .06), borderRadius: BorderRadius.circular(12)),
            child: Icon(_icons[p['id']] ?? Icons.extension_outlined, color: conn != null ? q.halo : q.text2),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p['name'] as String, style: qs(16, w: FontWeight.w600, c: q.text)),
              Text(conn == null ? (registered ? 'Not connected' : 'Waiting for app setup') : (conn['accountEmail'] ?? conn['accountName'] ?? 'Connected') as String, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(13, c: q.text3)),
            ]),
          ),
          if (conn != null) StatusPill(conn['status'] == 'ok' ? 'active' : (conn['status'] as String)) else if (!registered) const StatusPill('not_configured'),
        ]),
        const SizedBox(height: 10),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final f in feats)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: on.contains(f['id']) ? q.halo.withValues(alpha: .5) : q.line), color: on.contains(f['id']) ? q.halo.withValues(alpha: .08) : null),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (on.contains(f['id'])) ...[Icon(Icons.check, size: 13, color: q.halo), const SizedBox(width: 4)],
                Text(f['name'] as String, style: qs(12, w: FontWeight.w500, c: on.contains(f['id']) ? q.text : q.text2)),
              ]),
            ),
        ]),
        if (conn == null) ...[
          const SizedBox(height: 12),
          if (!registered)
            Text('The app owner still has to register Qline with ${p['name']}. Until then this can\'t connect.', style: qs(13, c: q.text3))
          else
            QButton('Connect with ${p['name']}', kind: QBtn.halo, icon: Icons.login, expand: true, onPressed: canManage ? onConnect : null),
        ] else if (conn['status'] != 'ok') ...[
          const SizedBox(height: 8),
          Text(conn['statusDetail'] as String? ?? 'This login expired. Reconnect to keep syncing.', style: qs(13, c: q.warn)),
        ],
      ]),
    );
  }
}

class _ConnectSheet extends StatefulWidget {
  const _ConnectSheet({required this.provider, required this.features});
  final Map<String, dynamic> provider;
  final List<Map<String, dynamic>> features;
  @override
  State<_ConnectSheet> createState() => _ConnectSheetState();
}

class _ConnectSheetState extends State<_ConnectSheet> {
  late final Set<String> _on = widget.features.map((f) => f['id'] as String).toSet();
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Connect ${widget.provider['name']}', style: qs(20, w: FontWeight.w600, c: q.text)),
          const SizedBox(height: 4),
          Text('Choose what Qline may use. You\'ll sign in on the ${widget.provider['name']} page, then come back here.', style: qs(14, c: q.text2, h: 1.4)),
          const SizedBox(height: 8),
          for (final f in widget.features)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _on.contains(f['id']),
              onChanged: (v) => setState(() => v == true ? _on.add(f['id'] as String) : _on.remove(f['id'])),
              title: Text(f['name'] as String, style: qs(15, w: FontWeight.w600, c: q.text)),
              subtitle: Text(f['detail'] as String? ?? '', style: qs(13, c: q.text2)),
            ),
          const SizedBox(height: 12),
          QButton('Continue to sign in', kind: QBtn.halo, icon: Icons.open_in_new, expand: true, onPressed: _on.isEmpty ? null : () => Navigator.pop(context, _on.toList())),
        ]),
      ),
    );
  }
}

/// One connected account: status, sync, per-feature controls, disconnect.
class ConnectionScreen extends ConsumerStatefulWidget {
  const ConnectionScreen({super.key, required this.provider, required this.onReconnect});
  final Map<String, dynamic> provider;
  final void Function(List<String>? features) onReconnect;
  @override
  ConsumerState<ConnectionScreen> createState() => _ConnectionState();
}

class _ConnectionState extends ConsumerState<ConnectionScreen> {
  late Map<String, dynamic> _conn = _m(widget.provider['connection']);
  bool _syncing = false;
  String get _p => widget.provider['id'] as String;
  Map<String, dynamic> get _settings => _m(_conn['settings']);
  List<String> get _features => (_conn['features'] as List?)?.cast<String>() ?? const [];

  Future<void> _reload() async {
    final d = _m(await ref.read(apiProvider).get('/integrations'));
    final p = items(d, 'providers').where((x) => x['id'] == _p).firstOrNull;
    if (p == null || p['connection'] == null) {
      if (mounted) Navigator.pop(context);
      return;
    }
    if (mounted) setState(() => _conn = _m(p['connection']));
  }

  Future<void> _patch(Map<String, dynamic> body) async {
    final r = await act(context, ref, (api) => api.patch('/integrations/$_p/settings', body));
    if (r != null && mounted) setState(() => _conn = _m(r));
  }

  Future<void> _sync() async {
    setState(() => _syncing = true);
    final r = await act(context, ref, (api) => api.post('/integrations/$_p/sync'));
    if (mounted) setState(() => _syncing = false);
    if (r == null || !mounted) return;
    final m = _m(r);
    final errs = (m['errors'] as List?) ?? const [];
    toast(context, errs.isNotEmpty ? 'Synced with problems: ${errs.first}' : 'Checked ${m['checked']} · ${m['leads']} new leads · ${m['exported']} rows sent to Sheets');
    ref.read(refreshTick.notifier).bump();
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final ok = _conn['status'] == 'ok';
    final sheet = _m(_settings['sheet']);
    final form = _m(_settings['form']);
    final channel = _m(_settings['channel']);
    final allFeatures = items(widget.provider, 'features');
    final missing = allFeatures.where((f) => !_features.contains(f['id'])).toList();
    return Page2(
      title: widget.provider['name'] as String,
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
          QCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Expanded(child: Text((_conn['accountEmail'] ?? _conn['accountName'] ?? 'Connected account') as String, style: qs(16, w: FontWeight.w600, c: q.text))), StatusPill(ok ? 'active' : _conn['status'] as String)]),
              const SizedBox(height: 6),
              KV('Connected', dateLabel(_conn['connectedAt'] as String?)),
              if (syncingProviders.contains(_p)) KV('Last sync', _conn['lastSyncAt'] == null ? 'Not yet' : ago(_conn['lastSyncAt'] as String?)),
              if (_settings['mode'] == 'test') const KV('Mode', 'Test data'),
              if (_conn['statusDetail'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_conn['statusDetail'] as String, style: qs(13, c: ok ? q.text2 : q.warn))),
              const SizedBox(height: 12),
              if (!ok)
                QButton('Reconnect', kind: QBtn.halo, icon: Icons.login, expand: true, onPressed: () => widget.onReconnect(_features.isEmpty ? null : _features))
              else if (syncingProviders.contains(_p))
                QButton('Sync now', icon: Icons.sync, busy: _syncing, expand: true, onPressed: _sync),
            ]),
          ),
          if (missing.isNotEmpty && ok) ...[
            const SectionLabel('Not allowed yet'),
            for (final f in missing)
              ListTile(contentPadding: const EdgeInsets.symmetric(horizontal: 4), title: Text(f['name'] as String), subtitle: Text(f['detail'] as String? ?? ''), trailing: TextButton(onPressed: () => widget.onReconnect([..._features, f['id'] as String]), child: const Text('Allow'))),
          ],
          if (_features.contains('gmail') || _features.contains('outlook')) ...[
            const SectionLabel('Lead inbox'),
            SwitchListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              title: Text(_p == 'google' ? 'Check Gmail for new leads' : 'Check Outlook for new leads'),
              subtitle: const Text('Every 15 minutes. Newsletters and ignored senders are skipped.'),
              value: _m(_settings[_p == 'google' ? 'gmail' : 'outlook'])['enabled'] != false,
              onChanged: (v) => _patch({_p == 'google' ? 'gmail' : 'outlook': {'enabled': v}}),
            ),
            ListTile(contentPadding: const EdgeInsets.symmetric(horizontal: 4), leading: const Icon(Icons.rule), title: const Text('Lead and urgency rules'), trailing: Icon(Icons.chevron_right, color: q.text3), onTap: () => push(context, const LeadRulesScreen())),
          ],
          if (_features.contains('sheets')) ...[
            const SectionLabel('Google Sheets'),
            if (sheet['id'] != null)
              ListTile(contentPadding: const EdgeInsets.symmetric(horizontal: 4), leading: const Icon(Icons.table_chart_outlined), title: const Text('Qline Leads sheet'), subtitle: const Text('New leads are added; rows you add become leads.'), trailing: const Icon(Icons.open_in_new), onTap: () => _open(context, sheet['url'] as String?))
            else
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: QButton('Create leads sheet', icon: Icons.add_chart, expand: true, onPressed: ok
                    ? () async {
                        final r = await act(context, ref, (api) => api.post('/integrations/google/sheet'), ok: 'Sheet created and synced');
                        if (r != null) await _reload();
                      }
                    : null),
              ),
          ],
          if (_features.contains('forms')) ...[
            const SectionLabel('Google Forms'),
            if (form['id'] != null) ...[
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                leading: const Icon(Icons.assignment_outlined),
                title: const Text('Lead form'),
                subtitle: Text(form['responderUri'] as String? ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(12, c: q.text3, family: mono)),
                trailing: IconButton(
                  tooltip: 'Copy form link',
                  icon: const Icon(Icons.copy),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: form['responderUri'] as String? ?? ''));
                    toast(context, 'Form link copied. Share it anywhere.');
                  },
                ),
                onTap: () => _open(context, form['responderUri'] as String?),
              ),
              Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => _open(context, form['editUrl'] as String?), icon: const Icon(Icons.edit_outlined, size: 18), label: const Text('Edit the form in Google'))),
            ] else
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: QButton('Create lead form', icon: Icons.post_add, expand: true, onPressed: ok
                    ? () async {
                        final title = await promptText(context, title: 'Form title', label: 'Title', initial: 'Contact us', action: 'Create');
                        if (title == null || !context.mounted) return;
                        final r = await act(context, ref, (api) => api.post('/integrations/google/form', {'title': title}), ok: 'Form created. Responses become leads automatically.');
                        if (r != null) await _reload();
                      }
                    : null),
              ),
          ],
          if (_features.contains('calendar') || _features.contains('ms_calendar')) ...[
            const SectionLabel('Calendar'),
            Text('Upcoming events show on Home. Workflows can add follow-up events.', style: qs(13, c: q.text2)),
          ],
          if (_p == 'slack') ...[
            const SectionLabel('Alert channel'),
            ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              leading: const Icon(Icons.tag),
              title: Text(channel['name'] == null ? 'Pick a channel' : '#${channel['name']}'),
              subtitle: const Text('Urgent leads and workflow messages go here'),
              trailing: Icon(Icons.chevron_right, color: q.text3),
              onTap: !ok
                  ? null
                  : () async {
                      final list = await act(context, ref, (api) => api.get('/integrations/slack/channels'));
                      if (list == null || !context.mounted) return;
                      final picked = await showModalBottomSheet<Map<String, dynamic>>(
                        context: context,
                        builder: (_) => SafeArea(child: ListView(shrinkWrap: true, children: [for (final c in items(list)) ListTile(leading: Icon(c['private'] == true ? Icons.lock_outline : Icons.tag), title: Text('${c['name']}'), onTap: () => Navigator.pop(context, c))])),
                      );
                      if (picked != null) await _patch({'channel': {'id': picked['id'], 'name': picked['name']}});
                    },
            ),
            if (channel['id'] != null) QButton('Send a test message', icon: Icons.send_outlined, expand: true, onPressed: () => act(context, ref, (api) => api.post('/integrations/slack/test'), ok: 'Sent. Check Slack.')),
          ],
          const SizedBox(height: 24),
          QButton('Disconnect', kind: QBtn.destructive, expand: true, onPressed: () async {
            if (!await confirm(context, title: 'Disconnect ${widget.provider['name']}?', body: 'Qline deletes the saved login and stops syncing. Leads already found stay in Qline.', action: 'Disconnect', destructive: true)) return;
            if (!context.mounted) return;
            final r = await act(context, ref, (api) => api.delete('/integrations/$_p'), ok: 'Disconnected');
            if (r != null && context.mounted) Navigator.pop(context);
          }),
        ]),
      ),
    );
  }
}

/// App-owner only: the one-time OAuth app registration (client ID + secret) for each provider.
class IntegrationSetupScreen extends ConsumerWidget {
  const IntegrationSetupScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Page2(
      title: 'Integration setup',
      body: Load<List<Map<String, dynamic>>>(
        fetch: (api) async => items(await api.get('/platform/oauth-apps')),
        builder: (context, list, reload) => ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
          Text('Register Qline once with each provider, then paste the client ID and secret here. After that every user connects their own account with a normal sign-in. Secrets are encrypted on the server and never shown again.', style: qs(14, c: q.text2, h: 1.45)),
          for (final a in list) ...[
            SectionLabel(a['name'] as String, trailing: StatusPill(a['configured'] == true ? 'active' : 'not_configured')),
            QCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Redirect URI', style: qs(12, w: FontWeight.w600, c: q.text3)),
                const SizedBox(height: 4),
                Row(children: [
                  Expanded(child: SelectableText(a['redirectUri'] as String, style: qs(12, c: q.text, family: mono))),
                  IconButton(
                    tooltip: 'Copy redirect URI',
                    icon: const Icon(Icons.copy, size: 18),
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: a['redirectUri'] as String));
                      toast(context, 'Copied');
                    },
                  ),
                ]),
                if (a['clientIdHint'] != null) KV('Client ID', a['clientIdHint'] as String),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: QButton(a['configured'] == true ? 'Replace keys' : 'Enter keys', kind: a['configured'] == true ? QBtn.secondary : QBtn.halo, onPressed: () async {
                    final saved = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (_) => _AppKeysSheet(app: a));
                    if (saved == true) reload();
                  })),
                  const SizedBox(width: 8),
                  QButton('Console', kind: QBtn.ghost, icon: Icons.open_in_new, onPressed: () => _open(context, a['console'] as String?)),
                ]),
                if (a['configured'] == true)
                  TextButton(
                    onPressed: () async {
                      if (!await confirm(context, title: 'Remove ${a['name']} keys?', body: 'Nobody can connect ${a['name']} until new keys are entered. Existing connections stop refreshing.', action: 'Remove', destructive: true)) return;
                      if (!context.mounted) return;
                      final r = await act(context, ref, (api) => api.delete('/platform/oauth-apps/${a['id']}'), ok: 'Removed');
                      if (r != null) reload();
                    },
                    child: Text('Remove keys', style: qs(13, c: q.bad)),
                  ),
              ]),
            ),
          ],
        ]),
      ),
    );
  }
}

class _AppKeysSheet extends ConsumerStatefulWidget {
  const _AppKeysSheet({required this.app});
  final Map<String, dynamic> app;
  @override
  ConsumerState<_AppKeysSheet> createState() => _AppKeysSheetState();
}

class _AppKeysSheetState extends ConsumerState<_AppKeysSheet> {
  final _id = TextEditingController(), _secret = TextEditingController();
  bool _busy = false, _show = false;
  @override
  void dispose() {
    _id.dispose();
    _secret.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${widget.app['name']} app keys', style: qs(20, w: FontWeight.w600, c: q.text)),
        const SizedBox(height: 12),
        TextField(controller: _id, autocorrect: false, decoration: const InputDecoration(labelText: 'Client ID')),
        const SizedBox(height: 12),
        TextField(
          controller: _secret,
          autocorrect: false,
          obscureText: !_show,
          decoration: InputDecoration(labelText: 'Client secret', suffixIcon: IconButton(tooltip: _show ? 'Hide' : 'Show', icon: Icon(_show ? Icons.visibility_off_outlined : Icons.visibility_outlined), onPressed: () => setState(() => _show = !_show))),
        ),
        const SizedBox(height: 16),
        QButton('Save', kind: QBtn.halo, busy: _busy, expand: true, onPressed: () async {
          setState(() => _busy = true);
          final r = await act(context, ref, (api) => api.put('/platform/oauth-apps/${widget.app['id']}', {'clientId': _id.text.trim(), 'clientSecret': _secret.text.trim()}), ok: 'Saved');
          if (!context.mounted) return;
          setState(() => _busy = false);
          if (r != null) Navigator.pop(context, true);
        }),
      ]),
    );
  }
}

/// Stripe connects with a restricted key the owner creates, so they choose exactly what Qline may touch.
class StripeKeySheet extends ConsumerStatefulWidget {
  const StripeKeySheet({super.key});
  @override
  ConsumerState<StripeKeySheet> createState() => _StripeKeySheetState();
}

class _StripeKeySheetState extends ConsumerState<StripeKeySheet> {
  final _key = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _key.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final k = _key.text.trim();
    if (!RegExp(r'^rk_(live|test)_').hasMatch(k)) {
      setState(() => _error = k.startsWith('sk_') ? 'That is a full secret key. Create a restricted key (rk_…) instead.' : 'A restricted key starts with rk_live_ or rk_test_.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).post('/integrations/stripe/key', {'key': k});
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    Widget perm(String t) => Padding(padding: const EdgeInsets.only(top: 4), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(Icons.check, size: 15, color: q.text2), const SizedBox(width: 6), Expanded(child: Text(t, style: qs(13, c: q.text2)))]));
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 16 + MediaQuery.viewInsetsOf(context).bottom),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Connect Stripe', style: qs(20, w: FontWeight.w600, c: q.text)),
            const SizedBox(height: 6),
            Text('In the Stripe Dashboard, go to Developers → API keys → Create restricted key, and allow only:', style: qs(14, c: q.text2, h: 1.4)),
            perm('Read: Balance, Charges, Customers, Invoices, Subscriptions, Products'),
            perm('Write: Customers, Invoices (for drafts only)'),
            const SizedBox(height: 8),
            Text('Qline never sends, finalizes, charges or refunds. Invoices it prepares stay drafts until you send them in Stripe.', style: qs(13, c: q.text3, h: 1.4)),
            const SizedBox(height: 4),
            TextButton.icon(onPressed: () => _open(context, 'https://dashboard.stripe.com/apikeys'), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('Open Stripe API keys')),
            TextField(
              controller: _key,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(labelText: 'Restricted key', hintText: 'rk_live_…', errorText: _error, errorMaxLines: 3),
              onSubmitted: (_) => _save(),
            ),
            const SizedBox(height: 14),
            QButton('Connect Stripe', kind: QBtn.halo, icon: Icons.link, expand: true, busy: _busy, onPressed: _save),
          ]),
        ),
      ),
    );
  }
}
