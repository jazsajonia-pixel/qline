import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/ui/markdown.dart';
import 'package:qline/ui/theme.dart';

String plain(List<MdSpan> s) => s.map((x) => x.text).join();

Widget host(Widget child) => MaterialApp(
  theme: buildTheme(false),
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

void main() {
  group('blocks', () {
    test('headings, lists, code, quote, rule and table', () {
      final b = parseMarkdown(
        '# Title\n\nSome **text**.\n\n- one\n- two\n\n3. three\n4. four\n\n```js\nlet a = "**x**";\n```\n> note\n\n---\n| Name | Qty |\n|---|---:|\n| Mango | 3 |\n| Durian | 1 |',
      );
      expect(b.map((x) => x.kind), [MdKind.heading, MdKind.paragraph, MdKind.bullets, MdKind.numbers, MdKind.code, MdKind.quote, MdKind.rule, MdKind.table]);
      expect(b[3].start, 3);
      expect(b[4].text, 'let a = "**x**";');
      expect(b[7].rows, [
        ['Name', 'Qty'],
        ['Mango', '3'],
        ['Durian', '1'],
      ]);
    });
    test('an unclosed code fence while streaming is still a code block', () {
      final b = parseMarkdown('Here:\n```\nnpm run', streaming: true);
      expect(b.last.kind, MdKind.code);
      expect(b.last.text, 'npm run');
    });
    test('a table header that is still arriving is held back, not shown as pipes', () {
      expect(parseMarkdown('Totals:\n\n| Name | Qty |', streaming: true).map((x) => x.kind), [MdKind.paragraph]);
    });
  });

  group('inline', () {
    test('bold, italic, code, strike', () {
      final s = parseInline('a **b** *c* _d_ `e` ~~f~~');
      expect(plain(s), 'a b c d e f');
      expect(s.firstWhere((x) => x.text == 'b').styles, {MdStyle.bold});
      expect(s.firstWhere((x) => x.text == 'c').styles, {MdStyle.italic});
      expect(s.firstWhere((x) => x.text == 'd').styles, {MdStyle.italic});
      expect(s.firstWhere((x) => x.text == 'e').styles, {MdStyle.code});
      expect(s.firstWhere((x) => x.text == 'f').styles, {MdStyle.strike});
    });
    test('no raw markers survive while streaming', () {
      for (final partial in ['The **tot', 'The **total**', 'Use `npm', 'see [the docs](https://exa', 'Done *', 'Done **']) {
        final text = plain(parseInline(partial, streaming: true));
        expect(text.contains('*'), isFalse, reason: partial);
        expect(text.contains('`'), isFalse, reason: partial);
        expect(text.contains(']('), isFalse, reason: partial);
      }
    });
    test('a finished answer keeps lone symbols as text', () {
      expect(plain(parseInline('2 * 3 = 6 and snake_case_name')), '2 * 3 = 6 and snake_case_name');
      expect(plain(parseInline('price is 5 ** 2')), 'price is 5 ** 2');
    });
    test('only http and https links open', () {
      final ok = parseInline('[site](https://qline.app/x)');
      expect(ok.single.url, 'https://qline.app/x');
      for (final bad in ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x', 'data:text/html,hi', '/relative']) {
        final s = parseInline('[click]($bad)');
        expect(s.every((x) => x.url == null), isTrue, reason: bad);
        expect(plain(s), 'click');
      }
      expect(parseInline('see https://qline.app/a.').firstWhere((x) => x.url != null).text, 'https://qline.app/a');
    });
    test('HTML is shown as text, never interpreted', () {
      expect(plain(parseInline('<script>alert(1)</script> <b>hi</b>')), '<script>alert(1)</script> <b>hi</b>');
    });
    test('tool ids in prose become plain words; urls and code blocks are left alone', () {
      expect(friendlyToolNames('I used tasks.search and `slack__post`.'), 'I used your tasks and Slack.');
      expect(friendlyToolNames('Visit https://tasks.example.com or tasks.search.example'), 'Visit https://tasks.example.com or tasks.search.example');
    });
  });

  group('widget', () {
    testWidgets('renders a complete answer without raw syntax', (t) async {
      await t.pumpWidget(host(const MarkdownText('## Summary\n\n**3** tasks are open:\n\n- Call *Ana*\n- Send `quote`\n\n| Task | Due |\n|---|---|\n| Call | Fri |')));
      final shown = t.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText()).join('\n');
      expect(shown, contains('Summary'));
      expect(shown, contains('3 tasks are open:'));
      expect(shown, contains('Call Ana'));
      expect(shown, contains('Fri'));
      for (final raw in ['**', '##', '|', '`', '- Call']) {
        expect(shown.contains(raw), isFalse, reason: raw);
      }
    });
    testWidgets('streams token by token without errors or raw markers', (t) async {
      const full = '**Open tasks**\n\n1. Call *Ana* about [the quote](https://qline.app/q)\n2. Check `tasks.search`\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      for (var n = 1; n <= full.length; n += 3) {
        await t.pumpWidget(host(MarkdownText(full.substring(0, n), streaming: true)));
        expect(t.takeException(), isNull);
        final shown = t.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText()).join('\n');
        expect(shown.contains('**'), isFalse, reason: full.substring(0, n));
        expect(shown.contains(']('), isFalse, reason: full.substring(0, n));
      }
      await t.pumpWidget(host(const MarkdownText(full)));
      final shown = t.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText()).join('\n');
      expect(shown, contains('Call Ana about the quote'));
    });
    testWidgets('a link asks before opening', (t) async {
      await t.pumpWidget(host(const MarkdownText('Read [the guide](https://qline.app/guide).')));
      await t.tapOnText(find.textRange.ofSubstring('the guide'));
      await t.pumpAndSettle();
      expect(find.text('Open this link?'), findsOneWidget);
      expect(find.text('qline.app'), findsOneWidget);
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(find.text('Open this link?'), findsNothing);
    });
  });
}
