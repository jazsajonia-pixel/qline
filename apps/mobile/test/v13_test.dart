import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qline/core/alerts.dart';
import 'package:qline/core/voice.dart';
import 'package:qline/screens/live.dart';

void main() {
  group('UtteranceGate (auto-send for voice)', () {
    test('sends after silence when no final result ever arrives', () {
      fakeAsync((a) {
        final sent = <String>[];
        final g = UtteranceGate(onCommit: sent.add, silence: const Duration(milliseconds: 1500));
        g.feed('what needs');
        a.elapse(const Duration(milliseconds: 700));
        g.feed('what needs my attention');
        a.elapse(const Duration(milliseconds: 1400));
        expect(sent, isEmpty);
        a.elapse(const Duration(milliseconds: 200));
        expect(sent, ['what needs my attention']);
      });
    });

    test('sends when the recogniser stops before a final result', () {
      final sent = <String>[];
      final g = UtteranceGate(onCommit: sent.add);
      g.feed('add a task');
      g.ended();
      expect(sent, ['add a task']);
    });

    test('sends exactly once across final + stop + silence', () {
      fakeAsync((a) {
        final sent = <String>[];
        final g = UtteranceGate(onCommit: sent.add);
        g.feed('hello', isFinal: true);
        g.ended();
        g.feed('hello again');
        a.elapse(const Duration(seconds: 3));
        expect(sent, ['hello']);
        g.reset();
        g.feed('next one');
        g.ended();
        expect(sent, ['hello', 'next one']);
      });
    });

    test('nothing heard means nothing sent', () {
      final sent = <String>[];
      final g = UtteranceGate(onCommit: sent.add);
      g.feed('   ');
      g.ended();
      expect(sent, isEmpty);
    });
  });

  test('syllables and word timing estimate', () {
    expect(syllables('cat'), 1);
    expect(syllables('morning,'), 2);
    expect(syllables('information'), 4);
    final t = estimateWordTimes(['Hello', 'there.', 'Two', 'leads'], .5);
    expect(t.length, 4);
    expect(t, orderedEquals([...t]..sort()));
    expect(t[1] - t[0], greaterThan(t[2] - t[1] - 400)); // sentence pause after "there."
  });

  test('core keeps its own band above the chat', () {
    expect(coreHeight(800, hasChat: false, voiceActive: false), closeTo(336, .1));
    expect(coreHeight(800, hasChat: true, voiceActive: false), 216);
    expect(coreHeight(800, hasChat: true, voiceActive: true), 288);
    expect(coreHeight(500, hasChat: true, voiceActive: false), 180);
  });

  test('phone alerts only for unread items newer than the last check', () {
    final list = <Map>[
      {'id': 'c', 'created_at': '2026-11-16T10:05:00Z', 'read_at': null},
      {'id': 'b', 'created_at': '2026-11-16T10:01:00Z', 'read_at': '2026-11-16T10:02:00Z'},
      {'id': 'a', 'created_at': '2026-11-16T09:00:00Z', 'read_at': null},
    ];
    expect(newAlerts(list, '2026-11-16T10:00:00Z').map((n) => n['id']), ['c']);
    expect(newAlerts(list, '2026-11-16T10:05:00Z'), isEmpty);
  });
}
