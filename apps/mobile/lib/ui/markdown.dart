import 'package:flutter/gestures.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import 'theme.dart';

/// Run 3 / M3 (docs/19): a small, safe Markdown renderer for AI answers.
///
/// Why self-written: flutter_markdown is discontinued, and the AI only needs a small subset. Nothing here
/// interprets HTML: tags are shown as plain text. Links open only for http/https, and only after the
/// person sees the address. While an answer is still streaming, unclosed markers style the rest of the
/// text instead of flashing raw `**` or a half-written table.

// ---------------------------------------------------------------- blocks

enum MdKind { paragraph, heading, code, bullets, numbers, table, quote, rule }

class MdBlock {
  MdBlock(this.kind, {this.text = '', this.level = 0, this.items = const [], this.rows = const [], this.start = 1});
  final MdKind kind;
  final String text;

  /// Heading level (1–3), or the code-block language is kept out on purpose: it is never shown.
  final int level;
  final List<String> items;

  /// Table rows; the first is the header.
  final List<List<String>> rows;

  /// First number of an ordered list.
  final int start;
}

final _fence = RegExp(r'^\s*(```|~~~)');
final _heading = RegExp(r'^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$');
final _bullet = RegExp(r'^\s{0,6}[-*+]\s+(.*)$');
final _number = RegExp(r'^\s{0,6}(\d{1,4})[.)]\s+(.*)$');
final _rule = RegExp(r'^\s{0,3}([-*_])(\s*\1){2,}\s*$');
final _tableSep = RegExp(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$');

List<String> _cells(String line) {
  var s = line.trim();
  if (s.startsWith('|')) s = s.substring(1);
  if (s.endsWith('|') && !s.endsWith(r'\|')) s = s.substring(0, s.length - 1);
  return s.split(RegExp(r'(?<!\\)\|')).map((c) => c.trim().replaceAll(r'\|', '|')).toList();
}

/// Splits Markdown into blocks. [streaming]: the text may stop mid-block.
List<MdBlock> parseMarkdown(String src, {bool streaming = false}) {
  final lines = src.replaceAll('\r\n', '\n').split('\n');
  final out = <MdBlock>[];
  final para = <String>[];
  void flush() {
    if (para.isNotEmpty) {
      out.add(MdBlock(MdKind.paragraph, text: para.join('\n')));
      para.clear();
    }
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    if (line.trim().isEmpty) {
      flush();
      i++;
      continue;
    }
    final f = _fence.firstMatch(line);
    if (f != null) {
      flush();
      final marker = f.group(1)!;
      final body = <String>[];
      i++;
      while (i < lines.length && !lines[i].trimLeft().startsWith(marker)) {
        body.add(lines[i]);
        i++;
      }
      i++; // closing fence (or end of a streaming answer)
      out.add(MdBlock(MdKind.code, text: body.join('\n')));
      continue;
    }
    final h = _heading.firstMatch(line);
    if (h != null) {
      flush();
      out.add(MdBlock(MdKind.heading, level: h.group(1)!.length.clamp(1, 3), text: h.group(2)!));
      i++;
      continue;
    }
    if (_rule.hasMatch(line)) {
      flush();
      out.add(MdBlock(MdKind.rule));
      i++;
      continue;
    }
    // A table needs a header row and a separator row. While streaming, a lone header row waits as text.
    if (line.contains('|') && i + 1 < lines.length && _tableSep.hasMatch(lines[i + 1])) {
      flush();
      final rows = <List<String>>[_cells(line)];
      i += 2;
      while (i < lines.length && lines[i].contains('|') && lines[i].trim().isNotEmpty) {
        rows.add(_cells(lines[i]));
        i++;
      }
      out.add(MdBlock(MdKind.table, rows: rows));
      continue;
    }
    if (streaming && i == lines.length - 1 && line.trimLeft().startsWith('|') && para.isEmpty) {
      // The header of a table that is still arriving: hold it back rather than show pipes.
      i++;
      continue;
    }
    final b = _bullet.firstMatch(line);
    final n = _number.firstMatch(line);
    if (b != null || n != null) {
      flush();
      final ordered = b == null;
      final items = <String>[];
      final start = ordered ? int.parse(n!.group(1)!) : 1;
      while (i < lines.length) {
        final l = lines[i];
        final m = ordered ? _number.firstMatch(l) : _bullet.firstMatch(l);
        if (m != null) {
          items.add(ordered ? m.group(2)! : m.group(1)!);
        } else if (l.trim().isNotEmpty && items.isNotEmpty && l.startsWith(RegExp(r'\s{2,}')) && _bullet.firstMatch(l) == null && _number.firstMatch(l) == null) {
          items[items.length - 1] = '${items.last} ${l.trim()}';
        } else {
          break;
        }
        i++;
      }
      out.add(MdBlock(ordered ? MdKind.numbers : MdKind.bullets, items: items, start: start));
      continue;
    }
    if (line.trimLeft().startsWith('>')) {
      flush();
      final q = <String>[];
      while (i < lines.length && lines[i].trimLeft().startsWith('>')) {
        q.add(lines[i].trimLeft().substring(1).trimLeft());
        i++;
      }
      out.add(MdBlock(MdKind.quote, text: q.join('\n')));
      continue;
    }
    para.add(line);
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- inline

enum MdStyle { bold, italic, code, strike }

class MdSpan {
  MdSpan(this.text, {this.styles = const {}, this.url});
  final String text;
  final Set<MdStyle> styles;

  /// Set only for http/https links.
  final String? url;
  @override
  String toString() => '${styles.map((s) => s.name).join('+')}${url != null ? '<$url>' : ''}"$text"';
}

/// Only web links open. Everything else (javascript:, file:, intent:, data:, relative paths) stays plain text.
String? safeUrl(String raw) {
  final u = Uri.tryParse(raw.trim());
  if (u == null || !(u.isScheme('http') || u.isScheme('https')) || u.host.isEmpty) return null;
  return u.toString();
}

/// Tool families the AI might mention by id. Kept in step with TOOL_FAMILY_NOUNS in packages/policy.
const toolFamilyNouns = {
  'records': 'your records', 'tasks': 'your tasks', 'documents': 'your documents', 'memory': 'your knowledge base', //
  'knowledge': 'your knowledge base', 'notes': 'notes', 'contacts': 'your contacts', 'companies': 'companies',
  'projects': 'your projects', 'drafts': 'drafts', 'config': 'settings', 'gmail': 'your email', 'email': 'your email',
  'calendar': 'your calendar', 'leads': 'your leads', 'approvals': 'approvals', 'workflows': 'your workflows',
  'forms': 'Google Forms', 'sheets': 'Google Sheets', 'notify': 'notifications', 'time': 'the time',
  'business': 'your business overview', 'slack': 'Slack', 'agents': 'your AI team', 'files': 'the file', 'chart': 'a chart',
  'image': 'an image', 'drive': 'Google Drive', 'notion': 'Notion', 'github': 'GitHub', 'stripe': 'Stripe', 'social': 'social media',
};

final _toolId = RegExp('(?<![\\w./@:-])`?(${toolFamilyNouns.keys.join('|')})(?:\\.|__)([a-z][a-z_]{1,30})`?(?![\\w/]|\\.\\w)');

/// Replaces tool ids the AI wrote in prose ("tasks.search", `slack__post`) with plain words ("your tasks").
/// Code blocks are left alone, so a person asking for technical detail still sees the real names there.
String friendlyToolNames(String s) => s.replaceAllMapped(_toolId, (m) => toolFamilyNouns[m.group(1)!]!);

final _autoLink = RegExp(r'https?://[^\s<>()\[\]]+[^\s<>()\[\].,;:!?"]');

/// Parses inline Markdown. Unclosed markers are literal text in a finished answer; while [streaming]
/// they style the rest, so `**Total` shows as bold "Total" rather than as asterisks.
List<MdSpan> parseInline(String src, {bool streaming = false}) {
  final out = <MdSpan>[];
  final buf = StringBuffer();
  final styles = <MdStyle>{};
  final open = <MdStyle, int>{}; // style -> index in [out] where it opened (for the unclosed fallback)
  void emit() {
    if (buf.isNotEmpty) {
      out.add(MdSpan(buf.toString(), styles: {...styles}));
      buf.clear();
    }
  }

  bool isWord(String c) => RegExp(r'[A-Za-z0-9]').hasMatch(c);
  var i = 0;
  while (i < src.length) {
    final c = src[i];
    final rest = src.substring(i);
    if (c == r'\' && i + 1 < src.length && r'\`*_[]()#|~>-'.contains(src[i + 1])) {
      buf.write(src[i + 1]);
      i += 2;
      continue;
    }
    if (c == '`') {
      final end = src.indexOf('`', i + 1);
      if (end > i + 1 || (end == -1 && streaming && i + 1 < src.length)) {
        emit();
        final code = end == -1 ? src.substring(i + 1) : src.substring(i + 1, end);
        out.add(MdSpan(code, styles: {...styles, MdStyle.code}));
        i = end == -1 ? src.length : end + 1;
        continue;
      }
      if (end == -1 && streaming) {
        i++;
        continue;
      }
    }
    if (c == '[') {
      final m = RegExp(r'^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)').firstMatch(rest);
      if (m != null) {
        emit();
        final url = safeUrl(m.group(2)!);
        for (final s in parseInline(m.group(1)!)) {
          out.add(MdSpan(s.text, styles: {...styles, ...s.styles}, url: url));
        }
        i += m.group(0)!.length;
        continue;
      }
      // A link that is still arriving: show just its text.
      final partial = RegExp(r'^\[([^\]\n]*)(\]\([^)\s]*)?$').firstMatch(rest);
      if (streaming && partial != null) {
        buf.write(partial.group(1));
        i = src.length;
        continue;
      }
    }
    if (c == 'h' && (i == 0 || !isWord(src[i - 1]))) {
      final m = _autoLink.matchAsPrefix(src, i);
      if (m != null) {
        emit();
        out.add(MdSpan(m.group(0)!, styles: {...styles}, url: safeUrl(m.group(0)!)));
        i = m.end;
        continue;
      }
    }
    final two = rest.length >= 2 ? rest.substring(0, 2) : '';
    if (two == '**' || two == '__' || two == '~~') {
      final st = two == '~~' ? MdStyle.strike : MdStyle.bold;
      if (styles.contains(st)) {
        emit();
        styles.remove(st);
        open.remove(st);
        i += 2;
        continue;
      }
      final closes = src.indexOf(two, i + 2) > i + 2;
      final next = i + 2 < src.length ? src[i + 2] : '';
      if ((closes || streaming) && next.trim().isNotEmpty) {
        emit();
        styles.add(st);
        open[st] = out.length;
        i += 2;
        continue;
      }
      if (streaming && next.isEmpty) {
        i += 2; // a marker at the very end of the stream: wait for what follows
        continue;
      }
    }
    if (c == '*' || c == '_') {
      final next = i + 1 < src.length ? src[i + 1] : '';
      final prev = i > 0 ? src[i - 1] : '';
      if (styles.contains(MdStyle.italic) && prev.trim().isNotEmpty && !(c == '_' && isWord(next))) {
        emit();
        styles.remove(MdStyle.italic);
        open.remove(MdStyle.italic);
        i++;
        continue;
      }
      final canOpen = next.trim().isNotEmpty && next != c && !(c == '_' && isWord(prev));
      if (canOpen) {
        final close = RegExp(c == '*' ? r'(?<=\S)\*(?!\*)' : r'(?<=\S)_(?![A-Za-z0-9_])');
        final hasClose = close.hasMatch(src.substring(i + 1));
        if (hasClose || streaming) {
          emit();
          styles.add(MdStyle.italic);
          open[MdStyle.italic] = out.length;
          i++;
          continue;
        }
      }
      if (streaming && next.isEmpty) {
        i++;
        continue;
      }
    }
    buf.write(c);
    i++;
  }
  emit();
  if (!streaming && open.isNotEmpty) {
    // Defensive: a finished answer with an unmatched marker keeps it as text (nothing gets swallowed).
    return [MdSpan(src)];
  }
  return out;
}

// ---------------------------------------------------------------- widget

/// Renders an AI answer. Selectable; links ask before leaving the app.
class MarkdownText extends StatefulWidget {
  const MarkdownText(this.text, {super.key, this.streaming = false, this.size = 15});
  final String text;
  final bool streaming;
  final double size;
  @override
  State<MarkdownText> createState() => _MarkdownTextState();
}

class _MarkdownTextState extends State<MarkdownText> {
  final _taps = <TapGestureRecognizer>[];

  void _clearTaps() {
    for (final t in _taps) {
      t.dispose();
    }
    _taps.clear();
  }

  @override
  void dispose() {
    _clearTaps();
    super.dispose();
  }

  Future<void> _open(String url) async {
    final uri = Uri.parse(url);
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          'Open this link?',
          style: qs(18, w: FontWeight.w600, c: ctx.q.text),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              uri.host,
              style: qs(15, w: FontWeight.w600, c: ctx.q.text),
            ),
            const SizedBox(height: 4),
            Text(
              url,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: qs(12, c: ctx.q.text2, family: mono),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Open')),
        ],
      ),
    );
    if (go == true) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  TextSpan _inline(String text, TextStyle base) {
    final q = context.q;
    final spans = <InlineSpan>[];
    for (final s in parseInline(friendlyToolNames(text), streaming: widget.streaming)) {
      var st = base;
      if (s.styles.contains(MdStyle.bold)) st = st.copyWith(fontWeight: FontWeight.w600);
      if (s.styles.contains(MdStyle.italic)) st = st.copyWith(fontStyle: FontStyle.italic);
      if (s.styles.contains(MdStyle.strike)) st = st.copyWith(decoration: TextDecoration.lineThrough);
      if (s.styles.contains(MdStyle.code)) st = st.copyWith(fontFamily: mono, fontSize: (base.fontSize ?? 15) * .88, backgroundColor: q.surface2);
      TapGestureRecognizer? tap;
      if (s.url != null) {
        st = st.copyWith(color: q.info, decoration: TextDecoration.underline, decorationColor: q.info.withValues(alpha: .5));
        final url = s.url!;
        tap = TapGestureRecognizer()..onTap = () => _open(url);
        _taps.add(tap);
      }
      spans.add(TextSpan(text: s.text, style: st, recognizer: tap));
    }
    return TextSpan(children: spans, style: base);
  }

  @override
  Widget build(BuildContext context) {
    _clearTaps();
    final q = context.q;
    final base = qs(widget.size, c: q.text, h: 1.5);
    final blocks = parseMarkdown(widget.text, streaming: widget.streaming);
    final children = <Widget>[];
    for (final b in blocks) {
      final gap = children.isEmpty ? 0.0 : 10.0;
      switch (b.kind) {
        case MdKind.paragraph:
          children.add(
            Padding(
              padding: EdgeInsets.only(top: gap),
              child: Text.rich(_inline(b.text, base)),
            ),
          );
        case MdKind.heading:
          final size = switch (b.level) {
            1 => widget.size + 4,
            2 => widget.size + 2,
            _ => widget.size + 1,
          };
          children.add(
            Padding(
              padding: EdgeInsets.only(top: children.isEmpty ? 0 : 14),
              child: Semantics(
                header: true,
                child: Text.rich(_inline(b.text, qs(size, w: FontWeight.w600, c: q.text, h: 1.3))),
              ),
            ),
          );
        case MdKind.code:
          children.add(
            Container(
              margin: EdgeInsets.only(top: gap),
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: q.surface2,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: q.line),
              ),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Text(
                  b.text,
                  style: qs(widget.size - 2, c: q.text, family: mono, h: 1.45),
                ),
              ),
            ),
          );
        case MdKind.bullets:
        case MdKind.numbers:
          final ordered = b.kind == MdKind.numbers;
          children.add(
            Padding(
              padding: EdgeInsets.only(top: gap),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (var k = 0; k < b.items.length; k++)
                    Padding(
                      padding: EdgeInsets.only(top: k == 0 ? 0 : 4),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: ordered ? 26 : 18,
                            child: Text(ordered ? '${b.start + k}.' : '•', style: base.copyWith(color: q.text2)),
                          ),
                          Expanded(child: Text.rich(_inline(b.items[k], base))),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          );
        case MdKind.quote:
          children.add(
            Container(
              margin: EdgeInsets.only(top: gap),
              padding: const EdgeInsets.only(left: 12),
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: q.lineStrong, width: 3)),
              ),
              child: Text.rich(_inline(b.text, base.copyWith(color: q.text2))),
            ),
          );
        case MdKind.rule:
          children.add(
            Padding(
              padding: EdgeInsets.symmetric(vertical: gap / 2 + 4),
              child: Divider(height: 1, color: q.line),
            ),
          );
        case MdKind.table:
          final cols = b.rows.map((r) => r.length).reduce((a, c) => a > c ? a : c);
          children.add(
            Padding(
              padding: EdgeInsets.only(top: gap),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Table(
                  defaultColumnWidth: const IntrinsicColumnWidth(),
                  border: TableBorder(
                    horizontalInside: BorderSide(color: q.line),
                    bottom: BorderSide(color: q.line),
                    top: BorderSide(color: q.line),
                  ),
                  children: [
                    for (var r = 0; r < b.rows.length; r++)
                      TableRow(
                        children: [
                          for (var c = 0; c < cols; c++)
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(maxWidth: 240),
                                child: Text.rich(
                                  _inline(
                                    c < b.rows[r].length ? b.rows[r][c] : '',
                                    r == 0 ? base.copyWith(fontWeight: FontWeight.w600, fontSize: widget.size - 1) : base.copyWith(fontSize: widget.size - 1),
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          );
      }
    }
    return SelectionArea(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: children),
    );
  }
}
