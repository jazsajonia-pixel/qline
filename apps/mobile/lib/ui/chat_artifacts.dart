// v1.6 run 2: things the AI shows in the chat (charts, images) and the files people attach.
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../screens/proposals.dart';
import 'theme.dart';
import 'widgets.dart' show push;

/// Flat, solid data colours (docs/03 §2 "Charts"). Citrine is kept for human actions, so it is
/// not a series colour. Live AI is always dark, so these are tuned for the dark surfaces.
const chartColors = [Color(0xFF8FB4FF), Color(0xFF7EDC8A), Color(0xFFFF9F4A), Color(0xFFF07AC0), Color(0xFFB08CFF), Color(0xFF36CDBE)];

/// One artifact from the `artifact` stream event or `meta.artifacts`.
class ChatArtifact extends StatelessWidget {
  const ChatArtifact(this.data, {super.key});
  final Map<String, dynamic> data;
  @override
  Widget build(BuildContext context) => switch (data['type']) {
        'chart' => ChatChart(data),
        'image' => ChatImage(fileId: data['fileId'] as String? ?? '', name: data['name'] as String? ?? 'Image', caption: data['caption'] as String?),
        'file' => Padding(padding: const EdgeInsets.only(top: 8), child: FileCard(fileId: data['fileId'] as String? ?? '', name: data['name'] as String? ?? 'File', kind: data['kind'] as String?, size: data['size'] as num?, source: data['source'] as String?)),
        'proposal' => Padding(padding: const EdgeInsets.only(top: 8), child: ProposalCard(id: data['id'] as String? ?? '', kind: data['kind'] as String? ?? 'mission', title: data['title'] as String? ?? 'Proposal')),
        _ => const SizedBox.shrink(),
      };
}

/// Phase 6: the AI proposed a mission or an agent change. Opens the review screen; nothing changed yet.
class ProposalCard extends StatelessWidget {
  const ProposalCard({super.key, required this.id, required this.kind, required this.title});
  final String id, kind, title;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Material(
      color: q.surface1,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: id.isEmpty ? null : () => push(context, ProposalScreen(id: id)),
        child: Container(
          constraints: const BoxConstraints(maxWidth: 320, minHeight: 56),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: q.halo.withValues(alpha: .6))),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(kind == 'mission' ? Icons.flag_outlined : Icons.tune, size: 22, color: q.halo),
            const SizedBox(width: 10),
            Flexible(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(13, w: FontWeight.w600, c: q.text)),
                Text(kind == 'mission' ? 'Proposed mission · Tap to review' : 'Proposed agent change · Tap to review', style: qs(11, c: q.text3)),
              ]),
            ),
            const SizedBox(width: 8),
            Icon(Icons.chevron_right, size: 18, color: q.text3),
          ]),
        ),
      ),
    );
  }
}

class ChartData {
  ChartData({required this.kind, required this.title, required this.labels, required this.series, this.unit, required this.source, required this.computed});
  final String kind, title, source;
  final String? unit;
  final bool computed;
  final List<String> labels;
  final List<({String name, List<double> values})> series;

  static ChartData? parse(Map<String, dynamic> d) {
    final labels = ((d['labels'] as List?) ?? const []).map((e) => '$e').toList();
    final series = <({String name, List<double> values})>[];
    for (final s in (d['series'] as List?) ?? const []) {
      if (s is! Map) continue;
      final values = ((s['values'] as List?) ?? const []).map((v) => v is num ? v.toDouble() : double.tryParse('$v') ?? 0).toList();
      // Never draw a series that does not line up with the labels.
      if (values.length != labels.length) continue;
      series.add((name: '${s['name'] ?? ''}', values: values));
    }
    if (labels.isEmpty || series.isEmpty) return null;
    final kind = d['chart'] as String? ?? 'bar';
    return ChartData(
      kind: const {'bar', 'line', 'pie'}.contains(kind) ? kind : 'bar',
      title: d['title'] as String? ?? 'Chart',
      labels: labels,
      series: kind == 'pie' ? series.take(1).toList() : series,
      unit: d['unit'] as String?,
      source: d['source'] as String? ?? 'unknown source',
      computed: d['computed'] == true,
    );
  }

  /// Where the numbers came from, shown under every chart.
  String get sourceLine => computed ? 'Computed by Qline from your data' : 'From: $source · provided by the AI';

  /// Screen-reader summary: the actual values, not just "a chart".
  String get summary {
    final kindName = switch (kind) { 'line' => 'Line chart', 'pie' => 'Pie chart', _ => 'Bar chart' };
    final parts = <String>[];
    for (final s in series) {
      final pairs = [for (var i = 0; i < labels.length && i < 24; i++) '${labels[i]} ${fmtNum(s.values[i])}${unit == null ? '' : ' $unit'}'];
      parts.add('${series.length > 1 || s.name.isNotEmpty ? '${s.name}: ' : ''}${pairs.join(', ')}${labels.length > 24 ? ', and ${labels.length - 24} more' : ''}');
    }
    return '$kindName: $title. ${parts.join('. ')}. $sourceLine.';
  }
}

String fmtNum(double v) {
  final a = v.abs();
  String trim(double x) => x == x.roundToDouble() ? x.toStringAsFixed(0) : x.toStringAsFixed(1);
  if (a >= 1e6) return '${trim(v / 1e6)}M';
  if (a >= 1e4) return '${trim(v / 1e3)}k';
  return v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(a < 10 ? 2 : 1);
}

class ChatChart extends StatelessWidget {
  const ChatChart(this.raw, {super.key});
  final Map<String, dynamic> raw;
  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final c = ChartData.parse(raw);
    if (c == null) {
      return _Frame(child: Text('This chart had no usable numbers, so it is not shown.', style: qs(13, c: q.text2)));
    }
    final reduce = MediaQuery.of(context).disableAnimations;
    final legend = c.kind == 'pie' ? null : (c.series.length > 1 ? [for (var i = 0; i < c.series.length; i++) (c.series[i].name, chartColors[i % chartColors.length])] : null);
    return Semantics(
      container: true,
      label: c.summary,
      child: _Frame(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ExcludeSemantics(child: Text(c.title, style: qs(14, w: FontWeight.w600, c: q.text))),
          if (c.unit != null) ExcludeSemantics(child: Text(c.unit!, style: qs(11, c: q.text3))),
          const SizedBox(height: 10),
          ExcludeSemantics(
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: reduce ? 1 : 0, end: 1),
              duration: reduce ? Duration.zero : const Duration(milliseconds: 520),
              curve: Curves.easeOutCubic,
              builder: (context, t, _) => c.kind == 'pie'
                  ? _PieWithLegend(c: c, t: t)
                  : SizedBox(height: 180, width: double.infinity, child: CustomPaint(painter: _AxisChartPainter(c, t, q.text3, q.line))),
            ),
          ),
          if (legend != null) ...[
            const SizedBox(height: 8),
            ExcludeSemantics(child: Wrap(spacing: 12, runSpacing: 4, children: [for (final (n, col) in legend) _Key(n, col)])),
          ],
          const SizedBox(height: 8),
          ExcludeSemantics(
            child: Row(children: [
              Icon(c.computed ? Icons.verified_outlined : Icons.link, size: 13, color: q.text3),
              const SizedBox(width: 5),
              Expanded(child: Text(c.sourceLine, maxLines: 2, overflow: TextOverflow.ellipsis, style: qs(11, c: q.text3))),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Frame extends StatelessWidget {
  const _Frame({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(top: 10),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
        decoration: BoxDecoration(color: context.q.surface1, borderRadius: BorderRadius.circular(12), border: Border.all(color: context.q.line)),
        child: child,
      );
}

class _Key extends StatelessWidget {
  const _Key(this.label, this.color);
  final String label;
  final Color color;
  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 10, height: 10, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2))),
        const SizedBox(width: 6),
        Flexible(child: Text(label, overflow: TextOverflow.ellipsis, style: qs(12, c: context.q.text2))),
      ]);
}

/// Bars (grouped when there are several series) and lines share one axis painter.
class _AxisChartPainter extends CustomPainter {
  _AxisChartPainter(this.c, this.t, this.textColor, this.gridColor);
  final ChartData c;
  final double t;
  final Color textColor, gridColor;

  TextPainter _label(String s, double maxW, {double size = 10}) =>
      TextPainter(text: TextSpan(text: s, style: qs(size, c: textColor)), textDirection: TextDirection.ltr, maxLines: 1, ellipsis: '…')..layout(maxWidth: math.max(1, maxW));

  @override
  void paint(Canvas canvas, Size size) {
    final all = [for (final s in c.series) ...s.values];
    final maxV = all.fold<double>(0, math.max);
    final minV = math.min(0.0, all.fold<double>(0, math.min));
    final top = _nice(maxV <= 0 ? 1 : maxV);
    final range = (top - minV) == 0 ? 1 : top - minV;
    const left = 34.0, bottom = 20.0, topPad = 6.0;
    final w = size.width - left, h = size.height - bottom - topPad;
    final grid = Paint()..color = gridColor..strokeWidth = 1;
    for (var i = 0; i <= 3; i++) {
      final v = minV + range * i / 3;
      final y = topPad + h - h * (v - minV) / range;
      canvas.drawLine(Offset(left, y), Offset(size.width, y), grid);
      final tp = _label(fmtNum(v), left - 6);
      tp.paint(canvas, Offset(left - 6 - tp.width, y - tp.height / 2));
    }
    final n = c.labels.length;
    final slot = w / n;
    final every = math.max(1, (n / math.max(1, (w / 46).floor())).ceil());
    for (var i = 0; i < n; i += every) {
      final tp = _label(c.labels[i], slot * every - 4);
      tp.paint(canvas, Offset(left + slot * (i + .5) - tp.width / 2, size.height - bottom + 5));
    }
    double y(double v) => topPad + h - h * (v - minV) / range * t;
    final zero = topPad + h - h * (0 - minV) / range;
    if (c.kind == 'line') {
      for (var si = 0; si < c.series.length; si++) {
        final col = chartColors[si % chartColors.length];
        final path = Path();
        for (var i = 0; i < n; i++) {
          final p = Offset(left + slot * (i + .5), y(c.series[si].values[i]));
          i == 0 ? path.moveTo(p.dx, p.dy) : path.lineTo(p.dx, p.dy);
        }
        canvas.drawPath(path, Paint()..style = PaintingStyle.stroke..strokeWidth = 2..strokeJoin = StrokeJoin.round..color = col);
        if (n <= 31) {
          for (var i = 0; i < n; i++) {
            canvas.drawCircle(Offset(left + slot * (i + .5), y(c.series[si].values[i])), 2.6, Paint()..color = col);
          }
        }
      }
      return;
    }
    final groups = c.series.length;
    final groupW = slot * .72;
    final barW = groupW / groups;
    for (var i = 0; i < n; i++) {
      for (var si = 0; si < groups; si++) {
        final v = c.series[si].values[i];
        final x = left + slot * i + (slot - groupW) / 2 + barW * si;
        final rect = Rect.fromLTRB(x + .5, math.min(y(v), zero), x + barW - .5, math.max(y(v), zero));
        canvas.drawRRect(RRect.fromRectAndCorners(rect, topLeft: const Radius.circular(3), topRight: const Radius.circular(3)), Paint()..color = chartColors[si % chartColors.length]);
      }
    }
  }

  static double _nice(double v) {
    final exp = math.pow(10, (math.log(v) / math.ln10).floor()).toDouble();
    for (final m in const [1.0, 2.0, 2.5, 5.0, 10.0]) {
      if (m * exp >= v) return m * exp;
    }
    return 10 * exp;
  }

  @override
  bool shouldRepaint(_AxisChartPainter o) => o.t != t || o.c != c || o.textColor != textColor;
}

class _PieWithLegend extends StatelessWidget {
  const _PieWithLegend({required this.c, required this.t});
  final ChartData c;
  final double t;
  @override
  Widget build(BuildContext context) {
    final values = c.series.first.values.map((v) => math.max(0.0, v)).toList();
    final total = values.fold<double>(0, (a, b) => a + b);
    return Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
      SizedBox.square(dimension: 132, child: CustomPaint(painter: _PiePainter(values, total, t, context.q.surface1))),
      const SizedBox(width: 14),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var i = 0; i < c.labels.length && i < 8; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: _Key('${c.labels[i]} · ${fmtNum(values[i])}${total > 0 ? ' (${(values[i] / total * 100).round()}%)' : ''}', chartColors[i % chartColors.length]),
            ),
          if (c.labels.length > 8) Text('+${c.labels.length - 8} more', style: qs(11, c: context.q.text3)),
        ]),
      ),
    ]);
  }
}

class _PiePainter extends CustomPainter {
  _PiePainter(this.values, this.total, this.t, this.gap);
  final List<double> values;
  final double total, t;
  final Color gap;
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    if (total <= 0) {
      canvas.drawCircle(rect.center, size.width / 2 - 9, Paint()..style = PaintingStyle.stroke..strokeWidth = 18..color = gap.withValues(alpha: .5));
      return;
    }
    var a = -math.pi / 2;
    for (var i = 0; i < values.length; i++) {
      final sweep = values[i] / total * math.pi * 2 * t;
      canvas.drawArc(rect.deflate(9), a, sweep, false, Paint()..style = PaintingStyle.stroke..strokeWidth = 18..color = chartColors[i % chartColors.length]);
      a += sweep;
    }
  }

  @override
  bool shouldRepaint(_PiePainter o) => o.t != t || o.values != values;
}

/// Images are fetched with the user's session (GET /files/:id/content), so they never need a
/// public URL. A small cache stops the list from refetching while scrolling.
class ChatImage extends ConsumerStatefulWidget {
  const ChatImage({super.key, required this.fileId, required this.name, this.caption, this.height = 200, this.compact = false});
  final String fileId, name;
  final String? caption;
  final double height;
  final bool compact;
  static final _cache = <String, Uint8List>{};
  /// For tests.
  static void clearCache() => _cache.clear();
  @override
  ConsumerState<ChatImage> createState() => _ChatImageState();
}

class _ChatImageState extends ConsumerState<ChatImage> {
  late Future<Uint8List> _bytes = _load();

  Future<Uint8List> _load() async {
    final hit = ChatImage._cache[widget.fileId];
    if (hit != null) return hit;
    final b = await ref.read(apiProvider).download('/files/${widget.fileId}/content');
    if (ChatImage._cache.length >= 24) ChatImage._cache.remove(ChatImage._cache.keys.first);
    return ChatImage._cache[widget.fileId] = b;
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final label = 'Image: ${widget.name}${widget.caption == null ? '' : '. ${widget.caption}'}';
    final body = FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snap) {
        if (snap.hasError) {
          return Container(
            height: 56,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(color: q.surface1, borderRadius: BorderRadius.circular(10), border: Border.all(color: q.line)),
            child: Row(children: [
              Icon(Icons.broken_image_outlined, size: 18, color: q.text3),
              const SizedBox(width: 8),
              Expanded(child: Text('Could not load ${widget.name}', overflow: TextOverflow.ellipsis, style: qs(13, c: q.text2))),
              TextButton(onPressed: () => setState(() => _bytes = _load()), child: const Text('Retry')),
            ]),
          );
        }
        if (!snap.hasData) {
          return Container(height: widget.height * .6, decoration: BoxDecoration(color: q.surface1, borderRadius: BorderRadius.circular(10)), alignment: Alignment.center, child: const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 1.6)));
        }
        return GestureDetector(
          onTap: () => showDialog<void>(
            context: context,
            builder: (_) => Dialog(
              backgroundColor: QColors.liveInk,
              insetPadding: const EdgeInsets.all(12),
              child: Stack(children: [
                InteractiveViewer(maxScale: 5, child: Image.memory(snap.data!, fit: BoxFit.contain)),
                Positioned(right: 4, top: 4, child: IconButton(tooltip: 'Close', onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close))),
              ]),
            ),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: ConstrainedBox(constraints: BoxConstraints(maxHeight: widget.height), child: Image.memory(snap.data!, fit: BoxFit.cover, gaplessPlayback: true)),
          ),
        );
      },
    );
    return Semantics(
      container: true,
      image: true,
      label: label,
      child: Padding(
        padding: EdgeInsets.only(top: widget.compact ? 6 : 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          ExcludeSemantics(child: body),
          if (widget.caption != null && widget.caption!.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: ExcludeSemantics(child: Text(widget.caption!, style: qs(12, c: q.text2)))),
        ]),
      ),
    );
  }
}

String fileSize(num? bytes) {
  final b = (bytes ?? 0).toDouble();
  if (b >= 1024 * 1024) return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
  if (b >= 1024) return '${(b / 1024).round()} KB';
  return '${b.round()} B';
}

IconData kindIcon(String? kind) => switch (kind) { 'image' => Icons.image_outlined, 'records' => Icons.table_chart_outlined, _ => Icons.description_outlined };

/// A file attached to a message: pending in the composer (removable) or sent (read-only).
/// Saves a copy of a stored file to the device (system "Save as" dialog). Used by sent attachments and file cards.
/// Tests replace [saveFileBytes] so no platform dialog is needed.
@visibleForTesting
Future<Object?> Function(String name, Uint8List bytes) saveFileBytes = (name, bytes) => FilePicker.saveFile(fileName: name, bytes: bytes);

Future<void> saveFileCopy(BuildContext context, WidgetRef ref, String fileId, String name) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final bytes = await ref.read(apiProvider).download('/files/$fileId/download');
    final where = await saveFileBytes(name, bytes);
    messenger?.showSnackBar(SnackBar(content: Text(where == null ? 'Not saved' : 'Saved $name')));
  } catch (e) {
    messenger?.showSnackBar(SnackBar(content: Text('Could not get $name: ${e is ApiException ? e.title : 'try again'}')));
  }
}

/// A file the AI found or made (Drive, imports, exports). Tap saves a copy.
class FileCard extends ConsumerWidget {
  const FileCard({super.key, required this.fileId, required this.name, this.kind, this.size, this.source});
  final String fileId, name;
  final String? kind, source;
  final num? size;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    return Semantics(
      button: true,
      label: 'File $name${size == null ? '' : ', ${fileSize(size)}'}. Double tap to save a copy.',
      excludeSemantics: true,
      child: Material(
        color: q.surface1,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: fileId.isEmpty ? null : () => saveFileCopy(context, ref, fileId, name),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 320, minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: q.line)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(kindIcon(kind), size: 22, color: q.text2),
              const SizedBox(width: 10),
              Flexible(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(13, w: FontWeight.w600, c: q.text)),
                  Text([?source, if (size != null) fileSize(size), 'Tap to save'].join(' · '), style: qs(11, c: q.text3)),
                ]),
              ),
              const SizedBox(width: 8),
              Icon(Icons.download_outlined, size: 18, color: q.text3),
            ]),
          ),
        ),
      ),
    );
  }
}

class AttachmentChip extends StatelessWidget {
  const AttachmentChip({super.key, required this.name, this.kind, this.size, this.uploading = false, this.onRemove, this.onTap});
  final String name;
  final String? kind;
  final num? size;
  final bool uploading;
  final VoidCallback? onRemove;
  /// Sent attachments: saves a copy. Null while composing.
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final chip = _chip(context);
    if (onTap == null) return chip;
    return Semantics(
      button: true,
      hint: 'Save a copy',
      child: InkWell(borderRadius: BorderRadius.circular(10), onTap: onTap, child: ConstrainedBox(constraints: const BoxConstraints(minHeight: 48), child: Center(widthFactor: 1, child: chip))),
    );
  }

  Widget _chip(BuildContext context) {
    final q = context.q;
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      padding: EdgeInsets.fromLTRB(10, onRemove == null ? 6 : 0, onRemove == null ? 10 : 0, onRemove == null ? 6 : 0),
      decoration: BoxDecoration(color: q.surface1, borderRadius: BorderRadius.circular(10), border: Border.all(color: q.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Flexible(
          child: Semantics(
            container: true,
            label: '${uploading ? 'Uploading' : 'Attached'}: $name${size == null ? '' : ', ${fileSize(size)}'}',
            child: ExcludeSemantics(
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (uploading) const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 1.6)) else Icon(kindIcon(kind), size: 16, color: q.text2),
                const SizedBox(width: 6),
                Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: qs(12, c: q.text))),
                if (size != null) Text('  ${fileSize(size)}', style: qs(11, c: q.text3)),
              ]),
            ),
          ),
        ),
        if (onRemove != null) IconButton(tooltip: 'Remove $name', onPressed: onRemove, icon: const Icon(Icons.close, size: 16), constraints: const BoxConstraints.tightFor(width: 48, height: 48)),
      ]),
    );
  }
}

/// A file chosen in the composer.
typedef ChatFile = ({String name, Uint8List bytes});

Future<ChatFile?> _platformPick() async {
  final files = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'csv', 'xlsx', 'json', 'txt', 'md', 'pdf', 'docx']);
  if (files.isEmpty) return null;
  final f = files.first;
  return (name: f.name, bytes: await f.readAsBytes());
}

/// Opens the system file picker. Tests replace it so no platform picker is needed.
Future<ChatFile?> Function() pickChatFile = _platformPick;

/// Limits match the API (services/api/src/modules/files.ts). They are checked here first so people
/// get an answer before a long upload.
const maxChatAttachments = 5;
const chatImageMaxBytes = 5 * 1024 * 1024, chatFileMaxBytes = 10 * 1024 * 1024;
final _imageName = RegExp(r'\.(png|jpe?g|webp|gif)$', caseSensitive: false);

class AttachmentTooLarge implements Exception {
  AttachmentTooLarge(this.image);
  final bool image;
  @override
  String toString() => image ? 'That image is over 5 MB. Pick a smaller one.' : 'That file is over 10 MB. Split it and try again.';
}

class PendingFile {
  PendingFile(this.name, this.size);
  final String name;
  final int size;
  String? id, kind;
  bool get uploading => id == null;
  Map<String, dynamic> toMeta() => {'id': id, 'name': name, 'kind': kind, 'size': size};
}

/// Files waiting in the composer: each is uploaded right away (POST /agents/attachments) and the
/// message only carries the returned ids.
class ChatAttachments extends ChangeNotifier {
  ChatAttachments(this._api);
  final Api Function() _api;
  final List<PendingFile> items = [];
  bool get full => items.length >= maxChatAttachments;
  bool get uploading => items.any((p) => p.uploading);

  /// Uploads [f]. Returns the server's note (e.g. "first 500 rows kept") or null. Throws
  /// [AttachmentTooLarge], [StateError] when full, or the API error; a failed file is removed.
  Future<String?> add(ChatFile f) async {
    if (full) throw StateError('You can attach up to $maxChatAttachments files to one message.');
    final image = _imageName.hasMatch(f.name);
    if (f.bytes.length > (image ? chatImageMaxBytes : chatFileMaxBytes)) throw AttachmentTooLarge(image);
    final p = PendingFile(f.name, f.bytes.length);
    items.add(p);
    notifyListeners();
    try {
      final r = (await _api().upload('/agents/attachments', f.name, f.bytes) as Map).cast<String, dynamic>();
      p.id = r['id'] as String;
      p.kind = r['kind'] as String?;
      notifyListeners();
      return r['note'] as String?;
    } catch (_) {
      items.remove(p);
      notifyListeners();
      rethrow;
    }
  }

  void remove(PendingFile p) {
    items.remove(p);
    notifyListeners();
  }

  /// Empties the tray and returns what was in it (for sending).
  List<PendingFile> take() {
    final out = List<PendingFile>.of(items);
    items.clear();
    notifyListeners();
    return out;
  }

  /// Puts files back after a failed send so they can be sent again without re-uploading.
  void restore(List<PendingFile> files) {
    if (items.isNotEmpty || files.isEmpty) return;
    items.addAll(files);
    notifyListeners();
  }
}
