import 'dart:math' as math;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

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

class KnowledgeGraphScreen extends ConsumerStatefulWidget {
  const KnowledgeGraphScreen({super.key, this.focus});
  /// `type:uuid` to open centred on one item (ego view).
  final String? focus;
  @override
  ConsumerState<KnowledgeGraphScreen> createState() => _KnowledgeGraphState();
}

class _KnowledgeGraphState extends ConsumerState<KnowledgeGraphScreen> {
  late String? _focus = widget.focus;
  bool _list = false;

  @override
  Widget build(BuildContext context) {
    return Page2(
      title: _focus == null ? 'Knowledge map' : 'Around one item',
      actions: [
        if (_focus != null) IconButton(tooltip: 'Whole map', icon: const Icon(Icons.zoom_out_map), onPressed: () => setState(() => _focus = null)),
        IconButton(tooltip: _list ? 'Show map' : 'Show as list', icon: Icon(_list ? Icons.hub_outlined : Icons.view_list_outlined), onPressed: () => setState(() => _list = !_list)),
      ],
      body: Load<Map>(
        key: ValueKey(_focus),
        fetch: (api) async => await api.get('/knowledge/graph', _focus == null ? {'view': 'overview'} : {'view': 'ego', 'focus': _focus, 'depth': 2}) as Map,
        builder: (context, g, _) {
          final nodes = items(g, 'nodes').map(GNode.fromJson).toList();
          final edges = items(g, 'edges').map(GEdge.fromJson).toList();
          if (nodes.isEmpty) {
            return const EmptyState(icon: Icons.hub_outlined, title: 'The map is empty', body: 'Add knowledge entries and connect them to contacts, projects or documents. They show up here.');
          }
          return Column(children: [
            if (g['truncated'] == true)
              Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text('Showing the most relevant ${nodes.length} items. Open one to see everything around it.', style: qs(12, c: context.q.text3))),
            Expanded(child: _list ? _GraphList(nodes: nodes, edges: edges, onOpen: _open) : _GraphCanvas(nodes: nodes, edges: edges, focus: _focus, onTap: _open)),
            const _Legend(),
          ]);
        },
      ),
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
                  if (n.visibility != null) VisibilityTag(private: n.visibility == 'private'),
                  if (n.status == 'proposed') const StatusPill('proposed'),
                ]),
                const SizedBox(height: 16),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  if (n.type == 'entry')
                    QButton('Open', icon: Icons.open_in_new, onPressed: () {
                      Navigator.pop(sheet);
                      push(context, KnowledgeEntryScreen(id: n.rawId));
                    }),
                  if (n.type != 'category' && n.id != _focus)
                    QButton('Center here', kind: QBtn.ghost, icon: Icons.center_focus_strong, onPressed: () {
                      Navigator.pop(sheet);
                      setState(() => _focus = n.id);
                    }),
                ]),
              ]),
            ),
          );
        },
      );
}

class _GraphCanvas extends StatefulWidget {
  const _GraphCanvas({required this.nodes, required this.edges, required this.focus, required this.onTap});
  final List<GNode> nodes;
  final List<GEdge> edges;
  final String? focus;
  final void Function(GNode) onTap;
  @override
  State<_GraphCanvas> createState() => _GraphCanvasState();
}

class _GraphCanvasState extends State<_GraphCanvas> {
  static const _size = 1000.0;
  final _tc = TransformationController();
  late Map<String, Offset> _pos = layoutGraph(widget.nodes, widget.edges, size: _size, focus: widget.focus);
  String? _selected;
  bool _fitted = false;

  @override
  void didUpdateWidget(covariant _GraphCanvas old) {
    super.didUpdateWidget(old);
    if (old.nodes != widget.nodes) {
      _pos = layoutGraph(widget.nodes, widget.edges, size: _size, focus: widget.focus);
      _fitted = false;
    }
  }

  @override
  void dispose() {
    _tc.dispose();
    super.dispose();
  }

  GNode? _hit(Offset scene) {
    GNode? best;
    var bestD = 30.0;
    for (final n in widget.nodes) {
      final p = _pos[n.id];
      if (p == null) continue;
      final d = (p - scene).distance;
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
    return LayoutBuilder(builder: (context, box) {
      if (!_fitted && box.maxWidth.isFinite) {
        final s = math.min(box.maxWidth, box.maxHeight) / _size;
        _tc.value = Matrix4.identity()
          ..translateByDouble((box.maxWidth - _size * s) / 2, (box.maxHeight - _size * s) / 2, 0, 1)
          ..scaleByDouble(s, s, 1, 1);
        _fitted = true;
      }
      return Semantics(
        label: 'Knowledge map with ${widget.nodes.length} items and ${widget.edges.length} connections. Use the list button for an accessible list.',
        child: GestureDetector(
          onTapUp: (d) {
            final n = _hit(_tc.toScene(d.localPosition));
            setState(() => _selected = n?.id);
            if (n != null) widget.onTap(n);
          },
          child: InteractiveViewer(
            transformationController: _tc,
            constrained: false,
            minScale: .2,
            maxScale: 4,
            boundaryMargin: const EdgeInsets.all(400),
            child: CustomPaint(size: const Size(_size, _size), painter: GraphPainter(nodes: widget.nodes, edges: widget.edges, pos: _pos, colors: c, selected: _selected, focus: widget.focus)),
          ),
        ),
      );
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
  GraphPainter({required this.nodes, required this.edges, required this.pos, required this.colors, this.selected, this.focus});
  final List<GNode> nodes;
  final List<GEdge> edges;
  final Map<String, Offset> pos;
  final QColors colors;
  final String? selected, focus;

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;
    for (final e in edges) {
      final a = pos[e.from], b = pos[e.to];
      if (a == null || b == null) continue;
      final hot = selected != null && (e.from == selected || e.to == selected);
      line.color = (e.relation == 'in' ? colors.line : colors.lineStrong).withValues(alpha: hot ? 1 : .7);
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
      final col = nodeColor(colors, n.type);
      final r = n.type == 'category' ? 14.0 + math.min(10, n.weight.toDouble()) : (n.id == focus ? 13.0 : 9.0);
      final fill = Paint()..color = n.status == 'proposed' ? colors.surface2 : col.withValues(alpha: n.type == 'category' ? .22 : .9);
      final ring = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = n.id == selected || n.id == focus ? 3 : 1.5
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
      final showLabel = n.type == 'category' || n.id == selected || n.id == focus || nodes.length <= 40;
      if (showLabel) {
        final tp = TextPainter(
          text: TextSpan(text: n.label.length > 28 ? '${n.label.substring(0, 27)}…' : n.label, style: qs(n.type == 'category' ? 13 : 11, w: n.type == 'category' ? FontWeight.w600 : FontWeight.w400, c: colors.text)),
          textDirection: TextDirection.ltr,
          maxLines: 1,
        )..layout(maxWidth: 180);
        final o = Offset(p.dx - tp.width / 2, p.dy + r + 4);
        canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(o.dx - 4, o.dy - 1, tp.width + 8, tp.height + 2), const Radius.circular(4)), Paint()..color = colors.bg.withValues(alpha: .8));
        tp.paint(canvas, o);
      }
    }
  }

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
  bool shouldRepaint(covariant GraphPainter old) => old.nodes != nodes || old.selected != selected || old.colors != colors || old.pos != pos;
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
