import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'integrations.dart';

/// Drive folder setup for Content Studio (docs/22 ADR-C1). Qline only maps folder IDs and checks them under one main
/// folder; it never creates, moves or shares anything in Drive.

/// A folder ID from a pasted Drive link or a bare ID; null when it is neither.
String? driveIdFrom(String input) {
  final s = input.trim();
  if (s.isEmpty) return null;
  final idOk = RegExp(r'^[A-Za-z0-9_-]{1,200}$');
  if (idOk.hasMatch(s)) return s;
  final uri = Uri.tryParse(s);
  if (uri == null || !uri.host.endsWith('google.com')) return null;
  final seg = uri.pathSegments;
  final i = seg.indexOf('folders');
  final id = i >= 0 && i + 1 < seg.length ? seg[i + 1] : uri.queryParameters['id'];
  return id != null && idOk.hasMatch(id) ? id : null;
}

/// Plain words for a folder check result (validateMapping reasons).
String folderReason(String? r) => switch (r) {
      'no_access' => "Qline can't open it. Check the link, or share it with the connected Google account.",
      'not_a_folder' => 'This is a file, not a folder.',
      'shortcut' => 'This is a shortcut. Use the real folder instead.',
      'trashed' => 'This folder is in the trash.',
      'trashed_parent' => 'A folder above it is in the trash.',
      'is_root' => 'This is the main folder itself. Pick a folder inside it.',
      'different_drive' => 'This folder is in a different drive from the main folder.',
      'outside_root' => 'This folder is not inside the main folder.',
      'too_deep' => 'This folder is too many levels below the main folder.',
      null => 'OK',
      _ => cap(r),
    };

const roleNames = {
  'root': 'Main folder',
  'assets': 'Source files',
  'ready_for_qa': 'Ready for QA',
  'external_reports': 'Reports',
  'incoming': 'Incoming',
  'acknowledged': 'Acknowledged',
  'completed': 'Completed',
  'failed': 'Failed',
  'logs': 'Logs',
};
const _moreRoles = ['incoming', 'acknowledged', 'completed', 'failed', 'logs'];

bool needsIntegrations(Object e) => e is ApiException && const {'NOT_CONNECTED', 'RECONNECT_REQUIRED', 'SCOPE_MISSING'}.contains(e.code);

class DriveFolderSetupScreen extends ConsumerStatefulWidget {
  const DriveFolderSetupScreen({super.key});
  @override
  ConsumerState<DriveFolderSetupScreen> createState() => _SetupState();
}

class _SetupState extends ConsumerState<DriveFolderSetupScreen> {
  int _gen = 0;
  @override
  Widget build(BuildContext context) => Page2(
        title: 'Drive folders',
        body: Load<Map>(
          key: ValueKey(_gen),
          fetch: (api) async => (await api.get('/content/drive-config')) as Map? ?? const {},
          builder: (context, cfg, reload) => _SetupForm(cfg: cfg.cast<String, dynamic>(), onSaved: () => setState(() => _gen++)),
        ),
      );
}

class _SetupForm extends ConsumerStatefulWidget {
  const _SetupForm({required this.cfg, required this.onSaved});
  final Map<String, dynamic> cfg;
  final VoidCallback onSaved;
  @override
  ConsumerState<_SetupForm> createState() => _SetupFormState();
}

class _SetupFormState extends ConsumerState<_SetupForm> {
  late final Map<String, dynamic> _roles = (widget.cfg['roles'] as Map?)?.cast<String, dynamic>() ?? const {};
  late final _root = TextEditingController(text: widget.cfg['rootFolderId'] as String? ?? '');
  late final List<TextEditingController> _assets = [
    for (final id in (_roles['assets'] as List?) ?? const ['']) TextEditingController(text: '$id'),
  ];
  late final Map<String, TextEditingController> _other = {
    for (final r in ['ready_for_qa', 'external_reports', ..._moreRoles]) r: TextEditingController(text: _roles[r] as String? ?? ''),
  };
  final _errors = <String, String>{};
  String? _busy;
  Object? _error;

  @override
  void dispose() {
    for (final c in [_root, ..._assets, ..._other.values]) {
      c.dispose();
    }
    super.dispose();
  }

  /// The mapping to save, or null with field errors set.
  Map<String, dynamic>? _mapping() {
    _errors.clear();
    String? id(String key, TextEditingController c, {bool required = false}) {
      final v = c.text.trim();
      if (v.isEmpty) {
        if (required) _errors[key] = 'Required';
        return null;
      }
      final out = driveIdFrom(v);
      if (out == null) _errors[key] = 'Paste a Drive folder link or ID';
      return out;
    }

    final root = id('root', _root, required: true);
    final assets = [for (final (i, c) in _assets.indexed) id('assets$i', c, required: i == 0)].whereType<String>().toList();
    final roles = <String, dynamic>{'assets': assets};
    for (final e in _other.entries) {
      final v = id(e.key, e.value, required: e.key == 'ready_for_qa');
      if (v != null) roles[e.key] = v;
    }
    setState(() {});
    return _errors.isEmpty ? {'rootFolderId': root, 'roles': roles} : null;
  }

  Future<void> _saveAndCheck() async {
    final m = _mapping();
    if (m == null) return;
    setState(() {
      _busy = 'check';
      _error = null;
    });
    final api = ref.read(apiProvider);
    try {
      await api.put('/content/drive-config', m);
      final r = await api.post('/content/drive-config/validate') as Map;
      if (mounted) toast(context, r['status'] == 'valid' ? 'Folders checked. You can sync now.' : 'Some folders need a fix. See below.');
      ref.read(refreshTick.notifier).bump();
      widget.onSaved();
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _sync() async {
    setState(() {
      _busy = 'sync';
      _error = null;
    });
    try {
      final r = await ref.read(apiProvider).post('/content/sync') as Map;
      final s = (r['sync'] as Map?) ?? const {};
      if (mounted) toast(context, 'Synced ${s['indexed'] ?? 0} files from ${s['folders'] ?? 0} folders.');
      ref.read(refreshTick.notifier).bump();
      widget.onSaved();
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Widget _field(String key, TextEditingController c, String label, String? help, {Widget? suffix}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextField(
          controller: c,
          enabled: _busy == null,
          autocorrect: false,
          decoration: InputDecoration(labelText: label, helperText: help, helperMaxLines: 3, errorText: _errors[key], suffixIcon: suffix),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final canManage = ref.watch(sessionProvider.select((s) => s.canManage));
    final cfg = widget.cfg;
    final status = cfg['status'] as String? ?? 'unconfigured';
    final v = (cfg['validation'] as Map?)?.cast<String, dynamic>();
    final checks = <Map>[if (v?['root'] is Map) {...(v!['root'] as Map), 'role': 'root'}, ...((v?['folders'] as List?) ?? const []).cast<Map>()];
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
      Text('Qline reads these folders. It never changes, moves or shares anything in your Drive.', style: qs(14, c: q.text2)),
      const SizedBox(height: 12),
      DriveStatusLine(cfg: cfg),
      if (_error != null) ...[
        const SizedBox(height: 12),
        _ErrorNote(error: _error!),
      ],
      if (checks.isNotEmpty && status != 'unconfigured') ...[
        const SectionLabel('Last check'),
        QCard(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Column(children: [
            for (final f in checks)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(f['ok'] == true ? Icons.check_circle_outline : Icons.error_outline, size: 18, color: f['ok'] == true ? q.ok : q.bad, semanticLabel: f['ok'] == true ? 'OK' : 'Problem'),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${roleNames[f['role']] ?? cap('${f['role']}')}${f['name'] != null ? ': ${f['name']}' : ''}', style: qs(14, w: FontWeight.w600, c: q.text)),
                      if (f['ok'] != true) Text(folderReason(f['reason'] as String?), style: qs(13, c: q.text2)),
                    ]),
                  ),
                ]),
              ),
            if (v?['accountEmail'] != null) Padding(padding: const EdgeInsets.only(top: 4, bottom: 6), child: Align(alignment: Alignment.centerLeft, child: Text('Checked with ${v!['accountEmail']}', style: qs(12, c: q.text3)))),
          ]),
        ),
      ],
      if (!canManage) ...[
        const SizedBox(height: 16),
        QCard(child: Row(children: [
          Icon(Icons.lock_outline, color: q.text3),
          const SizedBox(width: 12),
          Expanded(child: Text('Only owners and admins can change the folders or sync them.', style: qs(14, c: q.text2))),
        ])),
      ] else ...[
        const SectionLabel('Folders'),
        _field('root', _root, 'Main folder', 'Paste its Drive link or ID. Every folder below must be inside it.'),
        for (final (i, c) in _assets.indexed)
          _field('assets$i', c, i == 0 ? 'Source files' : 'Source files ${i + 1}', i == 0 ? 'Videos, images and audio your editor works from. Qline reads them only.' : null,
              suffix: i == 0 ? null : IconButton(tooltip: 'Remove this folder', onPressed: _busy != null ? null : () => setState(() => _assets.removeAt(i).dispose()), icon: const Icon(Icons.close))),
        if (_assets.length < 10)
          Align(
            alignment: Alignment.centerLeft,
            child: QButton('Add a source folder', kind: QBtn.ghost, icon: Icons.add, onPressed: _busy != null ? null : () => setState(() => _assets.add(TextEditingController()))),
          ),
        const SizedBox(height: 8),
        _field('ready_for_qa', _other['ready_for_qa']!, 'Ready for QA', 'Your editor puts the finished video here. Qline checks it before you review it.'),
        _field('external_reports', _other['external_reports']!, 'Reports (optional)', 'Your editor puts the result file here. Without it, you paste the result into the job.'),
        Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('More folders (optional)', style: qs(15, w: FontWeight.w500, c: q.text)),
            subtitle: Text('Only for your own filing. Qline does not move files between them.', style: qs(13, c: q.text3)),
            initiallyExpanded: _moreRoles.any((r) => _other[r]!.text.isNotEmpty),
            children: [for (final r in _moreRoles) _field(r, _other[r]!, roleNames[r]!, null)],
          ),
        ),
        const SizedBox(height: 12),
        QButton('Save and check folders', kind: QBtn.halo, icon: Icons.fact_check_outlined, expand: true, busy: _busy == 'check', onPressed: _busy != null ? null : _saveAndCheck),
        if (status == 'valid') ...[
          const SizedBox(height: 10),
          QButton('Sync now', icon: Icons.sync, expand: true, busy: _busy == 'sync', onPressed: _busy != null ? null : _sync),
          Padding(padding: const EdgeInsets.only(top: 6), child: Text('Lists every file again. Qline also checks for changes by itself every 10 minutes.', style: qs(12, c: q.text3))),
        ],
      ],
    ]);
  }
}

/// One line on where the Drive setup stands. Used here and in Content Studio.
class DriveStatusLine extends StatelessWidget {
  const DriveStatusLine({super.key, required this.cfg});
  final Map cfg;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final (icon, col, title, body) = driveStatus(q, cfg);
    return Semantics(
      container: true,
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, color: col, size: 20),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: qs(15, w: FontWeight.w600, c: q.text)),
            if (body.isNotEmpty) Text(body, style: qs(13, c: q.text2)),
          ]),
        ),
      ]),
    );
  }
}

/// Icon, colour, title and detail for the Drive setup status.
(IconData, Color, String, String) driveStatus(QColors q, Map cfg) {
  final status = cfg['status'] as String? ?? 'unconfigured';
  final err = cfg['lastError'] as String?;
  final changes = (cfg['changes'] as Map?) ?? const {};
  final synced = cfg['lastSuccessAt'] as String?;
  return switch (status) {
    'unconfigured' => (Icons.folder_off_outlined, q.text3, 'No Drive folders yet', 'Pick the folders your editor works in.'),
    'needs_revalidation' => (Icons.schedule, q.warn, 'Check the folders again', 'The folders changed since the last check.'),
    'invalid' => (Icons.error_outline, q.bad, 'Some folders need a fix', 'See the last check for what to change.'),
    _ when err != null => (Icons.report_outlined, q.warn, 'Drive folders ready, last sync had a problem', err),
    _ => (
        Icons.check_circle_outline,
        q.ok,
        'Drive folders ready',
        [
          synced == null ? 'Not synced yet' : 'Synced ${ago(synced)}',
          changes['watching'] == true ? 'Drive tells Qline about changes' : 'Checked for changes every 10 minutes',
        ].join('. '),
      ),
  };
}

class _ErrorNote extends StatelessWidget {
  const _ErrorNote({required this.error});
  final Object error;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final msg = error is ApiException ? (error as ApiException).message : 'Something went wrong.';
    return QCard(
      accent: q.bad.withValues(alpha: .5),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.error_outline, color: q.bad, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text(msg, style: qs(14, c: q.text))),
        ]),
        if (needsIntegrations(error)) ...[
          const SizedBox(height: 10),
          QButton('Open Integrations', icon: Icons.link, onPressed: () => push(context, const IntegrationsScreen())),
        ],
      ]),
    );
  }
}
