import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:material_ui/material_ui.dart';

import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'knowledge.dart';

/// Knowledge map (docs/14 K3). The API returns at most 150 nodes and 400 edges; the layout below
/// is a pure, seeded function so the same data always gives the same picture (and can be tested).

class GNode {
  const GNode({required this.id, required this.type, required this.label, this.category, this.kind, this.visibility, this.status, this.weight = 1});
  final String id, type, label;
  final String? category, kind, visibility, status;
  final num weight;
  factory GNode.fromJson(Map<String, dynamic> j) => GNode(
        id: j['id'] as String,
        type: j['type'] as String,
        label: j['label'] as String? ?? '',
        category: j['category'] as String?,
        kind: j['kind'] as String?,
        visibility: j['visibility'] as String?,
        status: j['status'] as String?,
        weight: j['weight'] as num? ?? 1,
      );
  String get rawId => id.substring(id.indexOf(':') + 1);
}

class GEdge {
  const GEdge(this.from, this.to, this.relation, {this.aiAdded = false});
  final String from, to, relation;
  final bool aiAdded;
  factory GEdge.fromJson(Map<String, dynamic> j) => GEdge(j['from'] as String, j['to'] as String, j['relation'] as String? ?? '', aiAdded: j['aiAdded'] == true);
}

/// FNV-1a: stable across runs and platforms (String.hashCode is not guaranteed to be).
int stableHash(String s) {
  var h = 0x811c9dc5;
  for (final u in s.codeUnits) {
    h ^= u;
    h = (h * 0x01000193) & 0xffffffff;
  }
  return h;
}

/// Seeded layout. Categories sit on an inner ring, entries cluster around their category, other
/// records sit on an outer ring near what links to them. A short, fixed number of repulsion /
/// spring steps then untangles it. No randomness: the seed is the node id.
Map<String, Offset> layoutGraph(List<GNode> nodes, List<GEdge> edges, {double size = 1000, int iterations = 80, String? focus}) {
  final center = Offset(size / 2, size / 2);
  final pos = <String, Offset>{};
  final cats = nodes.where((n) => n.type == 'category').toList()..sort((a, b) => a.id.compareTo(b.id));
  final catAngle = <String, double>{};
  for (var i = 0; i < cats.length; i++) {
    final a = (2 * math.pi * i) / math.max(1, cats.length) - math.pi / 2;
    catAngle[cats[i].rawId] = a;
    pos[cats[i].id] = center + Offset(math.cos(a), math.sin(a)) * size * .2;
  }
  double jitter(String id, int salt) => ((stableHash('$id#$salt') % 1000) / 1000.0) - .5;
  final rest = nodes.where((n) => n.type != 'category').toList()..sort((a, b) => a.id.compareTo(b.id));
  for (final n in rest) {
    if (n.id == focus) {
      pos[n.id] = center;
      continue;
    }
    final ca = n.category != null ? catAngle[n.category] : null;
    if (n.type == 'entry' && ca != null) {
      final a = ca + jitter(n.id, 1) * 1.2;
      final r = size * (.32 + jitter(n.id, 2) * .08);
      pos[n.id] = center + Offset(math.cos(a), math.sin(a)) * r;
    } else {
      final a = (stableHash(n.id) % 3600) / 3600.0 * 2 * math.pi;
      final r = size * (n.type == 'entry' ? .3 : .42) + jitter(n.id, 3) * size * .05;
      pos[n.id] = center + Offset(math.cos(a), math.sin(a)) * r;
    }
  }
  final ids = pos.keys.toList();
  final links = edges.where((e) => pos.containsKey(e.from) && pos.containsKey(e.to)).toList();
  final k = size / math.max(4, math.sqrt(ids.length.toDouble()) * 3);
  for (var it = 0; it < iterations; it++) {
    final t = (1 - it / iterations) * size * .02 + 1;
    final disp = {for (final id in ids) id: Offset.zero};
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        var d = pos[ids[i]]! - pos[ids[j]]!;
        var dist = d.distance;
        if (dist < .01) {
          d = Offset(jitter(ids[i], it) + .01, jitter(ids[j], it) + .01);
          dist = d.distance;
        }
        final f = (k * k) / dist;
        final push = d / dist * f;
        disp[ids[i]] = disp[ids[i]]! + push;
        disp[ids[j]] = disp[ids[j]]! - push;
      }
    }
    for (final e in links) {
      final d = pos[e.from]! - pos[e.to]!;
      final dist = math.max(.01, d.distance);
      final pull = d / dist * (dist * dist / k) * (e.relation == 'in' ? .6 : 1);
      disp[e.from] = disp[e.from]! - pull;
      disp[e.to] = disp[e.to]! + pull;
    }
    for (final id in ids) {
      if (id == focus) continue;
      final d = disp[id]!;
      final len = d.distance;
      if (len == 0) continue;
      var p = pos[id]! + d / len * math.min(len, t);
      // gentle gravity keeps disconnected nodes on screen
      p = p + (center - p) * .01;
      pos[id] = Offset(p.dx.clamp(24, size - 24), p.dy.clamp(24, size - 24));
    }
  }
  return pos;
}

/// Run 3 / M4 (docs/19): where node positions the person arranged are kept, per organisation and view.
abstract class GraphPositionStore {
  Future<Map<String, Offset>> read(String key);
  Future<void> write(String key, Map<String, Offset> pos);
  Future<void> clear(String key);
}

class SecureGraphPositionStore implements GraphPositionStore {
  const SecureGraphPositionStore([this._storage = const FlutterSecureStorage()]);
  final FlutterSecureStorage _storage;

  /// Positions are a convenience: a storage failure must never break the map.
  @override
  Future<Map<String, Offset>> read(String key) async {
    try {
      final raw = await _storage.read(key: key);
      if (raw == null) return {};
      final m = (jsonDecode(raw) as Map).cast<String, dynamic>();
      return {
        for (final e in m.entries)
          if (e.value is List && (e.value as List).length == 2) e.key: Offset(((e.value as List)[0] as num).toDouble(), ((e.value as List)[1] as num).toDouble()),
      };
    } catch (_) {
      return {};
    }
  }

  @override
  Future<void> write(String key, Map<String, Offset> pos) async {
    try {
      // Capped so a large map cannot grow storage without limit.
      final kept = pos.entries.take(maxSavedPositions);
      await _storage.write(key: key, value: jsonEncode({for (final e in kept) e.key: [e.value.dx.roundToDouble(), e.value.dy.roundToDouble()]}));
    } catch (_) {}
  }

  @override
  Future<void> clear(String key) async {
    try {
      await _storage.delete(key: key);
    } catch (_) {}
  }
}

const maxSavedPositions = 300;
final graphPositionStoreProvider = Provider<GraphPositionStore>((ref) => const SecureGraphPositionStore());

/// Node types in the order filters and the list show them.
const graphTypes = ['category', 'entry', 'contact', 'company', 'project', 'task', 'document'];
String graphTypeLabel(String t) => switch (t) { 'category' => 'Categories', 'entry' => 'Entries', 'contact' => 'Contacts', 'company' => 'Companies', 'project' => 'Projects', 'task' => 'Tasks', 'document' => 'Documents', _ => cap(t) };

/// Applies the type filter and "connected only"; edges are kept only when both ends stay.
({List<GNode> nodes, List<GEdge> edges}) filterGraph(List<GNode> nodes, List<GEdge> edges, {Set<String>? types, bool connectedOnly = false}) {
  var keep = nodes.where((n) => types == null || types.contains(n.type)).toList();
  var ids = {for (final n in keep) n.id};
  var e = edges.where((x) => ids.contains(x.from) && ids.contains(x.to)).toList();
  if (connectedOnly) {
    final linked = {for (final x in e) ...[x.from, x.to]};
    keep = keep.where((n) => linked.contains(n.id)).toList();
    ids = {for (final n in keep) n.id};
    e = e.where((x) => ids.contains(x.from) && ids.contains(x.to)).toList();
  }
  return (nodes: keep, edges: e);
}

/// Case-insensitive label search; returns matching node ids.
Set<String> searchGraph(List<GNode> nodes, String q) {
  final t = q.trim().toLowerCase();
  if (t.isEmpty) return const {};
  return {for (final n in nodes) if (n.label.toLowerCase().contains(t) || (n.category?.toLowerCase().contains(t) ?? false)) n.id};
}

class KnowledgeGraphScreen extends ConsumerStatefulWidget {
  const KnowledgeGraphScreen({super.key, this.focus});
  /// `type:uuid` to open centred on one item (ego view).
  final String? focus;
  @override
  ConsumerState<KnowledgeGraphScreen> createState() => _KnowledgeGraphState();
}

class _KnowledgeGraphState extends ConsumerState<KnowledgeGraphScreen> {
  late String? _focus = widget.focus;

  @override
  Widget build(BuildContext context) {
    return Page2(
      title: _focus == null ? 'Knowledge map' : 'Around one item',
      actions: [
        if (_focus != null) IconButton(tooltip: 'Whole map', icon: const Icon(Icons.zoom_out_map), onPressed: () => setState(() => _focus = null)),
      ],
      body: KnowledgeGraphView(
        focus: _focus,
        onFocus: (id) => setState(() => _focus = id),
        actions: (sheet, n) => [
          if (n.type == 'entry')
            QButton('Open', icon: Icons.open_in_new, onPressed: () {
              Navigator.pop(sheet);
              push(context, KnowledgeEntryScreen(id: n.rawId));
            }),
        ],
      ),
    );
  }
}

/// The map with search, filters, list view and node inspector. Used full-screen and inside the chat.
class KnowledgeGraphView extends ConsumerStatefulWidget {
  const KnowledgeGraphView({super.key, this.focus, required this.onFocus, this.actions, this.compact = false});
  final String? focus;
  final ValueChanged<String?> onFocus;

  /// Extra buttons in the node inspector (for example "Add to chat").
  final List<Widget> Function(BuildContext sheet, GNode n)? actions;

  /// Smaller chrome for the in-chat sheet.
  final bool compact;
  @override
  ConsumerState<KnowledgeGraphView> createState() => _KnowledgeGraphViewState();
}

class _KnowledgeGraphViewState extends ConsumerState<KnowledgeGraphView> {
  bool _list = false;
  bool _connectedOnly = false;
  Set<String>? _types; // null = all
  final _search = TextEditingController();
  final _canvas = GlobalKey<KnowledgeCanvasState>();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.q;
    final org = ref.watch(sessionProvider.select((s) => s.orgId)) ?? 'none';
    return Load<Map>(
      key: ValueKey(widget.focus),
      fetch: (api) async => await api.get('/knowledge/graph', widget.focus == null ? {'view': 'overview'} : {'view': 'ego', 'focus': widget.focus, 'depth': 2}) as Map,
      builder: (context, g, _) {
        final all = items(g, 'nodes').map(GNode.fromJson).toList();
        final allEdges = items(g, 'edges').map(GEdge.fromJson).toList();
        if (all.isEmpty) {
          return const EmptyState(icon: Icons.hub_outlined, title: 'The map is empty', body: 'Add knowledge entries and connect them to contacts, projects or documents. They show up here.');
        }
        final present = graphTypes.where((t) => all.any((n) => n.type == t)).toList();
        final f = filterGraph(all, allEdges, types: _types, connectedOnly: _connectedOnly);
        final matches = searchGraph(f.nodes, _search.text);
        Widget chip(String label, bool on, VoidCallback tap) => Padding(
              padding: const EdgeInsets.only(right: 6),
              child: FilterChip(label: Text(label, style: qs(12, c: on ? c.text : c.text2)), selected: on, showCheckmark: false, visualDensity: VisualDensity.compact, onSelected: (_) => tap()),
            );
        return Column(children: [
          Padding(
            padding: EdgeInsets.fromLTRB(12, widget.compact ? 0 : 8, 12, 4),
            child: Row(children: [
              Expanded(
                child: TextField(
                  controller: _search,
                  textInputAction: TextInputAction.search,
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: 'Search the map',
                    prefixIcon: const Icon(Icons.search, size: 20),
                    suffixIcon: _search.text.isEmpty ? null : IconButton(tooltip: 'Clear search', icon: const Icon(Icons.close, size: 18), onPressed: () => setState(_search.clear)),
                  ),
                  onChanged: (_) => setState(() {}),
                  onSubmitted: (_) {
                    final first = f.nodes.where((n) => matches.contains(n.id)).firstOrNull;
                    if (first != null) _canvas.currentState?.centerOn(first.id);
                  },
                ),
              ),
              const SizedBox(width: 6),
              IconButton(tooltip: _list ? 'Show map' : 'Show as list', icon: Icon(_list ? Icons.hub_outlined : Icons.view_list_outlined), onPressed: () => setState(() => _list = !_list)),
            ]),
          ),
          SizedBox(
            height: 40,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
              chip('All', _types == null && !_connectedOnly, () => setState(() {
                    _types = null;
                    _connectedOnly = false;
                  })),
              for (final t in present)
                chip(graphTypeLabel(t), _types?.contains(t) ?? false, () => setState(() {
                      final next = {...?_types};
                      next.contains(t) ? next.remove(t) : next.add(t);
                      _types = next.isEmpty ? null : next;
                    })),
              chip('Connected only', _connectedOnly, () => setState(() => _connectedOnly = !_connectedOnly)),
            ]),
          ),
          if (g['truncated'] == true)
            Padding(padding: const EdgeInsets.fromLTRB(16, 2, 16, 0), child: Text('Showing the most relevant ${all.length} items. Open one to see everything around it.', style: qs(12, c: c.text3))),
          if (_search.text.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 0),
              child: Align(alignment: Alignment.centerLeft, child: Text(matches.isEmpty ? 'No matches' : '${matches.length} match${matches.length == 1 ? '' : 'es'}${_list ? '' : ' · press search to jump to the first'}', style: qs(12, c: c.text3))),
            ),
          Expanded(
            child: f.nodes.isEmpty
                ? EmptyState(icon: Icons.filter_alt_off_outlined, title: 'Nothing matches these filters', body: 'Turn a filter off to see more of the map.')
                : _list
                    ? _GraphList(nodes: _search.text.trim().isEmpty ? f.nodes : f.nodes.where((n) => matches.contains(n.id)).toList(), edges: f.edges, onOpen: (n) => _open(n))
                    : KnowledgeCanvas(
                        key: _canvas,
                        nodes: f.nodes,
                        edges: f.edges,
                        focus: widget.focus,
                        highlight: matches,
                        storageKey: 'qline.kgpos.$org.${widget.focus ?? 'overview'}',
                        onTap: _open,
                      ),
          ),
          if (!widget.compact) const _Legend(),
        ]);
      },
    );
  }

  void _open(GNode n) => showModalBottomSheet(
        context: context,
        showDragHandle: true,
        builder: (sheet) {
          final c = sheet.q;
          return SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Icon(knowledgeTypeIcon(n.type), color: c.text2),
                  const SizedBox(width: 8),
                  Expanded(child: Text(n.label, style: qs(17, w: FontWeight.w600, c: c.text))),
                ]),
                const SizedBox(height: 6),
                Wrap(spacing: 10, children: [
                  Text(cap(n.type), style: qs(13, c: c.text3)),
                  if (n.kind != null) Text(cap(n.kind!), style: qs(13, c: c.text3)),
                  if (n.category != null && n.type == 'entry') Text(n.category!, style: qs(13, c: c.text3)),
                  if (n.visibility != null) VisibilityTag(private: n.visibility == 'private'),
                  if (n.status == 'proposed') const StatusPill('proposed'),
                ]),
                const SizedBox(height: 16),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  ...?widget.actions?.call(sheet, n),
                  if (n.type != 'category' && n.id != widget.focus)
                    QButton('Center here', kind: QBtn.ghost, icon: Icons.center_focus_strong, onPressed: () {
                      Navigator.pop(sheet);
                      widget.onFocus(n.id);
                    }),
                ]),
              ]),
            ),
          );
        },
      );
}

/// A pannable, zoomable map. Tap a node to inspect it; press and hold a node, then drag, to move it.
/// Moved nodes are remembered on this device ([storageKey]); "Reset layout" forgets them.
class KnowledgeCanvas extends ConsumerStatefulWidget {
  const KnowledgeCanvas({super.key, required this.nodes, required this.edges, this.focus, this.highlight = const {}, required this.storageKey, required this.onTap});
  final List<GNode> nodes;
  final List<GEdge> edges;
  final String? focus;
  final Set<String> highlight;
  final String storageKey;
  final void Function(GNode) onTap;
  @override
  ConsumerState<KnowledgeCanvas> createState() => KnowledgeCanvasState();
}

class KnowledgeCanvasState extends ConsumerState<KnowledgeCanvas> with SingleTickerProviderStateMixin {
  static const size = 1000.0;
  final _tc = TransformationController();
  late final AnimationController _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 260));
  Animation<Matrix4>? _tween;

  /// Label detail follows the zoom level in steps, so panning never repaints the map.
  final _lod = ValueNotifier<int>(1);
  late Map<String, Offset> _auto = layoutGraph(widget.nodes, widget.edges, size: size, focus: widget.focus);
  Map<String, Offset> _saved = {};
  String? _selected, _dragging;
  Size? _viewport;
  bool _fitted = false;

  Map<String, Offset> get pos => {..._auto, for (final e in _saved.entries) if (_auto.containsKey(e.key)) e.key: e.value};

  @override
  void initState() {
    super.initState();
    _tc.addListener(_onTransform);
    _anim.addListener(() {
      if (_tween != null) _tc.value = _tween!.value;
    });
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    final s = await ref.read(graphPositionStoreProvider).read(widget.storageKey);
    if (mounted && s.isNotEmpty) setState(() => _saved = s);
  }

  @override
  void didUpdateWidget(covariant KnowledgeCanvas oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.nodes.length != widget.nodes.length || oldWidget.edges.length != widget.edges.length || oldWidget.focus != widget.focus) {
      _auto = layoutGraph(widget.nodes, widget.edges, size: size, focus: widget.focus);
    }
    if (oldWidget.storageKey != widget.storageKey) {
      _saved = {};
      _loadSaved();
    }
  }

  void _onTransform() {
    final s = _tc.value.getMaxScaleOnAxis();
    _lod.value = s < .45 ? 0 : (s < 1.1 ? 1 : 2);
  }

  @override
  void dispose() {
    _tc.dispose();
    _anim.dispose();
    _lod.dispose();
    super.dispose();
  }

  Matrix4 _matrix(Offset sceneCenter, double scale) {
    final v = _viewport ?? const Size(size, size);
    return Matrix4.identity()
      ..translateByDouble(v.width / 2 - sceneCenter.dx * scale, v.height / 2 - sceneCenter.dy * scale, 0, 1)
      // Scale z too: InteractiveViewer reads the zoom level with getMaxScaleOnAxis().
      ..scaleByDouble(scale, scale, scale, 1);
  }

  void _animateTo(Matrix4 m) {
    if (MediaQuery.of(context).disableAnimations) {
      _tc.value = m;
      return;
    }
    _tween = Matrix4Tween(begin: _tc.value.clone(), end: m).animate(CurvedAnimation(parent: _anim, curve: Curves.easeOutCubic));
    _anim.forward(from: 0);
  }

  /// Fits every node in view.
  void fit({bool animate = true}) {
    final v = _viewport;
    final p = pos.values;
    if (v == null || p.isEmpty) return;
    var minX = double.infinity, minY = double.infinity, maxX = -double.infinity, maxY = -double.infinity;
    for (final o in p) {
      minX = math.min(minX, o.dx);
      minY = math.min(minY, o.dy);
      maxX = math.max(maxX, o.dx);
      maxY = math.max(maxY, o.dy);
    }
    final w = math.max(120.0, maxX - minX + 120), h = math.max(120.0, maxY - minY + 120);
    final scale = math.min(v.width / w, v.height / h).clamp(.1, 2.5);
    final m = _matrix(Offset((minX + maxX) / 2, (minY + maxY) / 2), scale);
    animate ? _animateTo(m) : _tc.value = m;
  }

  void zoom(double factor) {
    final v = _viewport;
    if (v == null) return;
    final scale = (_tc.value.getMaxScaleOnAxis() * factor).clamp(.1, 5.0);
    _animateTo(_matrix(_tc.toScene(Offset(v.width / 2, v.height / 2)), scale));
  }

  void centerOn(String id) {
    final p = pos[id];
    if (p == null) return;
    setState(() => _selected = id);
    _animateTo(_matrix(p, math.max(1.2, _tc.value.getMaxScaleOnAxis())));
  }

  Future<void> resetLayout() async {
    await ref.read(graphPositionStoreProvider).clear(widget.storageKey);
    setState(() {
      _saved = {};
      _auto = layoutGraph(widget.nodes, widget.edges, size: size, focus: widget.focus);
    });
    fit();
  }

  GNode? _hit(Offset scene) {
    GNode? best;
    final scale = _tc.value.getMaxScaleOnAxis();
    var bestD = math.max(18.0, 28.0 / scale); // stays about a fingertip wide at any zoom
    final p = pos;
    for (final n in widget.nodes) {
      final o = p[n.id];
      if (o == null) continue;
      final d = (o - scene).distance;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.q;
    final p = pos;
    Widget ctl(String tip, IconData icon, VoidCallback onTap) => IconButton(
          tooltip: tip,
          onPressed: onTap,
          icon: Icon(icon, size: 20),
          style: IconButton.styleFrom(backgroundColor: c.surface1, foregroundColor: c.text2, side: BorderSide(color: c.line)),
          constraints: const BoxConstraints.tightFor(width: 44, height: 44),
        );
    return LayoutBuilder(builder: (context, box) {
      _viewport = Size(box.maxWidth, box.maxHeight);
      if (!_fitted && box.maxWidth.isFinite) {
        _fitted = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) fit(animate: false);
        });
      }
      return Stack(children: [
        Positioned.fill(
          child: Semantics(
            label: 'Knowledge map with ${widget.nodes.length} items and ${widget.edges.length} connections. Use the list button for an accessible list.',
            child: InteractiveViewer(
              transformationController: _tc,
              constrained: false,
              minScale: .1,
              maxScale: 5,
              // Run 3 / M4: the canvas pans without edges.
              boundaryMargin: const EdgeInsets.all(double.infinity),
              panEnabled: _dragging == null,
              scaleEnabled: _dragging == null,
              child: GestureDetector(
                onTapUp: (d) {
                  final n = _hit(d.localPosition);
                  setState(() => _selected = n?.id);
                  if (n != null) widget.onTap(n);
                },
                onLongPressStart: (d) {
                  final n = _hit(d.localPosition);
                  if (n != null) setState(() => _dragging = _selected = n.id);
                },
                onLongPressMoveUpdate: (d) {
                  final id = _dragging;
                  if (id == null) return;
                  setState(() => _saved = {..._saved, id: Offset(d.localPosition.dx.clamp(12, size - 12), d.localPosition.dy.clamp(12, size - 12))});
                },
                onLongPressEnd: (_) {
                  if (_dragging == null) return;
                  setState(() => _dragging = null);
                  ref.read(graphPositionStoreProvider).write(widget.storageKey, _saved);
                },
                child: CustomPaint(
                  size: const Size(size, size),
                  painter: GraphPainter(nodes: widget.nodes, edges: widget.edges, pos: p, colors: c, selected: _selected, focus: widget.focus, highlight: widget.highlight, lod: _lod),
                ),
              ),
            ),
          ),
        ),
        Positioned(
          right: 10,
          bottom: 10,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ctl('Zoom in', Icons.add, () => zoom(1.4)),
            const SizedBox(height: 6),
            ctl('Zoom out', Icons.remove, () => zoom(1 / 1.4)),
            const SizedBox(height: 6),
            ctl('Fit to screen', Icons.fit_screen_outlined, fit),
            const SizedBox(height: 6),
            ctl('Reset layout', Icons.restart_alt, resetLayout),
          ]),
        ),
        if (_selected != null)
          Positioned(
            left: 12,
            bottom: 12,
            child: Text('Hold a node, then drag to move it', style: qs(11, c: c.text3)),
          ),
      ]);
    });
  }
}

/// Colour + shape per type so the map does not rely on colour alone.
Color nodeColor(QColors c, String type) => switch (type) {
      'category' => c.halo,
      'entry' => c.text2,
      'contact' => c.info,
      'company' => c.ok,
      'project' => c.warn,
      'task' => c.lineStrong,
      _ => c.text3,
    };

class GraphPainter extends CustomPainter {
  GraphPainter({required this.nodes, required this.edges, required this.pos, required this.colors, this.selected, this.focus, this.highlight = const {}, this.lod}) : super(repaint: lod);
  final List<GNode> nodes;
  final List<GEdge> edges;
  final Map<String, Offset> pos;
  final QColors colors;
  final String? selected, focus;

  /// Search matches: drawn at full strength, everything else is dimmed.
  final Set<String> highlight;

  /// 0 = far (category labels only), 1 = normal, 2 = close (every label).
  final ValueListenable<int>? lod;

  /// Labels laid out once per node and reused while zooming.
  static final _labels = <String, TextPainter>{};

  TextPainter _label(GNode n) {
    final key = '${n.id}|${n.label}|${colors.text.toARGB32()}';
    return _labels[key] ??= (TextPainter(
      text: TextSpan(text: n.label.length > 28 ? '${n.label.substring(0, 27)}…' : n.label, style: qs(n.type == 'category' ? 13 : 11, w: n.type == 'category' ? FontWeight.w600 : FontWeight.w400, c: colors.text)),
      textDirection: TextDirection.ltr,
      maxLines: 1,
    )..layout(maxWidth: 180));
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (_labels.length > 2000) _labels.clear();
    final level = lod?.value ?? 1;
    // Selecting a node shows its neighbourhood: its links and neighbours stay bright, the rest dims.
    final near = <String>{};
    if (selected != null) {
      near.add(selected!);
      for (final e in edges) {
        if (e.from == selected) near.add(e.to);
        if (e.to == selected) near.add(e.from);
      }
    }
    bool dim(String id) => (highlight.isNotEmpty && !highlight.contains(id)) || (near.isNotEmpty && !near.contains(id));
    final line = Paint()
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;
    for (final e in edges) {
      final a = pos[e.from], b = pos[e.to];
      if (a == null || b == null) continue;
      final hot = selected != null && (e.from == selected || e.to == selected);
      final faded = !hot && (dim(e.from) || dim(e.to));
      line.color = (e.relation == 'in' ? colors.line : colors.lineStrong).withValues(alpha: hot ? 1 : (faded ? .25 : .7));
      line.strokeWidth = hot ? 2.2 : 1.2;
      if (e.aiAdded) {
        _dashed(canvas, a, b, line);
      } else {
        canvas.drawLine(a, b, line);
      }
    }
    for (final n in nodes) {
      final p = pos[n.id];
      if (p == null) continue;
      final faded = dim(n.id);
      final col = nodeColor(colors, n.type).withValues(alpha: faded ? .3 : 1);
      final r = _radius(n);
      final fill = Paint()..color = n.status == 'proposed' ? colors.surface2 : col.withValues(alpha: (n.type == 'category' ? .22 : .9) * (faded ? .35 : 1));
      final ring = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = n.id == selected || n.id == focus || highlight.contains(n.id) ? 3 : 1.5
        ..color = n.id == selected ? colors.halo : col;
      switch (n.type) {
        case 'category':
          final rr = RRect.fromRectAndRadius(Rect.fromCircle(center: p, radius: r), const Radius.circular(6));
          canvas.drawRRect(rr, fill);
          canvas.drawRRect(rr, ring);
        case 'entry':
          canvas.drawCircle(p, r, fill);
          canvas.drawCircle(p, r, ring);
          if (n.visibility == 'private') canvas.drawCircle(p, r * .35, Paint()..color = colors.bg);
        default:
          final path = Path()
            ..moveTo(p.dx, p.dy - r)
            ..lineTo(p.dx + r, p.dy)
            ..lineTo(p.dx, p.dy + r)
            ..lineTo(p.dx - r, p.dy)
            ..close();
          canvas.drawPath(path, fill);
          canvas.drawPath(path, ring);
      }
    }
    // Labels last, most important first; a label that would overlap one already drawn is skipped.
    int rank(GNode n) => n.id == selected ? 0 : (n.id == focus ? 1 : (highlight.contains(n.id) ? 2 : (n.type == 'category' ? 3 : (near.contains(n.id) ? 4 : 5))));
    final order = [...nodes]..sort((a, b) {
        final r = rank(a).compareTo(rank(b));
        return r != 0 ? r : b.weight.compareTo(a.weight);
      });
    final placed = <Rect>[];
    for (final n in order) {
      final p = pos[n.id];
      if (p == null) continue;
      final must = rank(n) <= 2;
      final show = must || n.type == 'category' || near.contains(n.id) || level == 2 || (level == 1 && nodes.length <= 60);
      if (!show) continue;
      final tp = _label(n);
      final o = Offset(p.dx - tp.width / 2, p.dy + _radius(n) + 4);
      final rect = Rect.fromLTWH(o.dx - 4, o.dy - 1, tp.width + 8, tp.height + 2);
      if (!must && placed.any((x) => x.overlaps(rect))) continue;
      placed.add(rect);
      canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(4)), Paint()..color = colors.bg.withValues(alpha: .85));
      tp.paint(canvas, o);
    }
  }

  double _radius(GNode n) => n.type == 'category' ? 14.0 + math.min(10, n.weight.toDouble()) : (n.id == focus ? 13.0 : 9.0);

  void _dashed(Canvas canvas, Offset a, Offset b, Paint p) {
    final d = b - a;
    final len = d.distance;
    if (len == 0) return;
    final dir = d / len;
    for (var s = 0.0; s < len; s += 9) {
      canvas.drawLine(a + dir * s, a + dir * math.min(len, s + 5), p);
    }
  }

  @override
  bool shouldRepaint(covariant GraphPainter old) =>
      old.nodes != nodes || old.selected != selected || old.colors != colors || !mapEquals(old.pos, pos) || !setEquals(old.highlight, highlight) || old.focus != focus;
}

class _Legend extends StatelessWidget {
  const _Legend();
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    Widget item(String t, Color col, IconData i) => Row(mainAxisSize: MainAxisSize.min, children: [Icon(i, size: 14, color: col), const SizedBox(width: 4), Text(t, style: qs(12, c: c.text2))]);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      decoration: BoxDecoration(color: c.surface1, border: Border(top: BorderSide(color: c.line))),
      child: Wrap(spacing: 14, runSpacing: 6, children: [
        item('Category', c.halo, Icons.square_rounded),
        item('Entry', c.text2, Icons.circle),
        item('Private entry', c.text2, Icons.radio_button_checked),
        item('Contact', c.info, Icons.diamond),
        item('Company', c.ok, Icons.diamond),
        item('Project', c.warn, Icons.diamond),
        item('Dashed: added by AI', c.lineStrong, Icons.more_horiz),
      ]),
    );
  }
}

/// Accessible alternative: every node with its connections, as a list.
class _GraphList extends StatelessWidget {
  const _GraphList({required this.nodes, required this.edges, required this.onOpen});
  final List<GNode> nodes;
  final List<GEdge> edges;
  final void Function(GNode) onOpen;
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    final byId = {for (final n in nodes) n.id: n};
    final order = ['category', 'entry', 'contact', 'company', 'project', 'task', 'document'];
    final sorted = [...nodes]..sort((a, b) {
        final t = order.indexOf(a.type).compareTo(order.indexOf(b.type));
        return t != 0 ? t : a.label.toLowerCase().compareTo(b.label.toLowerCase());
      });
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      itemCount: sorted.length,
      itemBuilder: (_, i) {
        final n = sorted[i];
        final out = edges.where((e) => e.from == n.id && e.relation != 'in').map((e) => '${knowledgeRelations[e.relation] ?? cap(e.relation)} ${byId[e.to]?.label ?? ''}').toList();
        final count = edges.where((e) => e.from == n.id || e.to == n.id).length;
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(knowledgeTypeIcon(n.type), color: nodeColor(c, n.type)),
          title: Text(n.label, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text([cap(n.type), if (n.visibility == 'private') 'Private', '$count connection${count == 1 ? '' : 's'}', ...out.take(2)].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(12, c: c.text3)),
          onTap: () => onOpen(n),
        );
      },
    );
  }
}

/// Run 3 / M4B: knowledge entries one chat message can carry (the API accepts up to 5).
const maxChatKnowledge = 5;

/// Opens the knowledge map over the chat. Returns the entry the person chose to add ({id, title}),
/// or null if they just looked. The conversation underneath is untouched.
Future<Map<String, String>?> showKnowledgeSheet(BuildContext context, {Set<String> already = const {}}) => showModalBottomSheet<Map<String, String>>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      // Dragging pans the map, so the sheet itself is closed with the button or Back.
      enableDrag: false,
      builder: (sheet) => SizedBox(height: MediaQuery.of(sheet).size.height * .86, child: _KnowledgeSheet(already: already)),
    );

class _KnowledgeSheet extends StatefulWidget {
  const _KnowledgeSheet({required this.already});
  final Set<String> already;
  @override
  State<_KnowledgeSheet> createState() => _KnowledgeSheetState();
}

class _KnowledgeSheetState extends State<_KnowledgeSheet> {
  String? _focus;
  @override
  Widget build(BuildContext context) {
    final c = context.q;
    final already = widget.already;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 4, 0),
        child: Row(children: [
          Icon(Icons.hub_outlined, size: 18, color: c.text2),
          const SizedBox(width: 8),
          Expanded(child: Semantics(header: true, child: Text(_focus == null ? 'Knowledge' : 'Around one item', style: qs(16, w: FontWeight.w600, c: c.text)))),
          if (_focus != null) IconButton(tooltip: 'Whole map', icon: const Icon(Icons.zoom_out_map), onPressed: () => setState(() => _focus = null)),
          IconButton(tooltip: 'Close and return to the chat', icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
        child: Align(alignment: Alignment.centerLeft, child: Text('Tap an entry to add it to your next message. Only what you add is sent.', style: qs(12, c: c.text3))),
      ),
      Expanded(
        child: KnowledgeGraphView(
          compact: true,
          focus: _focus,
          onFocus: (id) => setState(() => _focus = id),
          actions: (inspector, n) => [
            if (n.type == 'entry')
              QButton(
                already.contains(n.rawId) ? 'Already added' : 'Add to chat',
                kind: QBtn.halo,
                icon: Icons.add_comment_outlined,
                onPressed: already.contains(n.rawId)
                    ? null
                    : () {
                        Navigator.pop(inspector);
                        Navigator.pop(context, {'id': n.rawId, 'title': n.label});
                      },
              ),
          ],
        ),
      ),
    ]);
  }
}
