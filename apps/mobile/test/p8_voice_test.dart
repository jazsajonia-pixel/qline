import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qline/core/voice.dart';

/// Phase 8 (M6): adaptive end-of-turn. Free, on-device; no provider involved.
void main() {
  const base = Duration(milliseconds: 1500);
  test('waits longer after a dangling word or comma', () {
    expect(waitFor('remind me to call mom and', base).inMilliseconds, 2400);
    expect(waitFor('add a task um', base).inMilliseconds, 2400);
    expect(waitFor('first, ', base).inMilliseconds, 2400);
  });
  test('short fragments get a little more time; long or punctuated requests less', () {
    expect(waitFor('okay', base).inMilliseconds, 1900);
    expect(waitFor('what is on my calendar tomorrow afternoon for the team', base).inMilliseconds, 1250);
    expect(waitFor('what time is it?', base).inMilliseconds, 1100);
    expect(waitFor('show my tasks', base), base);
  });
  test('always stays within 800–2600 ms', () {
    expect(waitFor('and', const Duration(milliseconds: 2200)).inMilliseconds, 2600);
    expect(waitFor('done.', const Duration(milliseconds: 1000)).inMilliseconds, 800);
  });
  test('the gate holds a dangling sentence open, then sends once speech resumes and ends', () {
    fakeAsync((f) {
      final sent = <String>[];
      final g = UtteranceGate(onCommit: sent.add);
      g.feed('remind me to call mom and');
      f.elapse(const Duration(milliseconds: 1800));
      expect(sent, isEmpty); // a fixed 1.5 s gate would have cut the user off here
      g.feed('remind me to call mom and dad tonight');
      f.elapse(const Duration(milliseconds: 1600));
      expect(sent, ['remind me to call mom and dad tonight']);
    });
  });
}
