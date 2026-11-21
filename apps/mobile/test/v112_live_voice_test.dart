import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:qline/core/live_audio.dart';
import 'package:qline/core/live_conversation.dart';
import 'package:qline/core/neural_voice.dart';
import 'package:qline/core/speech_text.dart';
import 'package:qline/core/voice.dart';
import 'package:qline/screens/live.dart' show liveMessage;
import 'package:qline/screens/voice_settings.dart' show describeTimeline;

// ---- fakes -------------------------------------------------------------------------------------------
class FakeEngine implements LiveAudioEngine {
  final ctl = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final calls = <String>[];
  final played = <int>[];
  Uint8List? preRoll;
  bool injectOk = true;
  ({int seq, int heardMs, bool wasPlaying}) flushResult = (seq: -1, heardMs: 0, wasPlaying: false);

  @override
  Stream<Map<String, dynamic>> get events => ctl.stream;
  void emit(Map<String, dynamic> e) => ctl.add(e);

  @override
  Future<Map<String, dynamic>> capabilities() async => {'aec': true};
  @override
  Future<Map<String, dynamic>> start({bool aec = true, bool service = true}) async {
    calls.add('start');
    return {'ok': true, 'aec': aec, 'inject': true};
  }

  @override
  Future<void> stop() async => calls.add('stop');
  @override
  Future<void> play(int seq, Uint8List pcm, int rate) async {
    calls.add('play:$seq');
    played.add(seq);
  }

  @override
  Future<({int seq, int heardMs, bool wasPlaying})> flush() async {
    calls.add('flush');
    return flushResult;
  }

  @override
  Future<({bool ok, bool inject})> listen({String? locale, Uint8List? preRoll, bool inject = true}) async {
    calls.add('listen:${inject ? 'inject' : 'legacy'}');
    this.preRoll = preRoll;
    return (ok: true, inject: inject && injectOk);
  }

  @override
  Future<void> endListen() async => calls.add('endListen');
  @override
  Future<void> cancelListen() async => calls.add('cancelListen');
}

class FakeVad implements SpeechDetector {
  bool voice = false, strict = false;
  @override
  VadResult accept(Float32List frame) => VadResult(voice, strict);
  @override
  void reset() {}
}

/// 200 ms of 16 kHz audio per word; [gate] holds synthesis until completed.
class FakeSynth implements Synthesizer {
  final texts = <String>[];
  Completer<void>? gate;
  @override
  Future<SynthAudio> synth(String text, {int? voice, double? speed}) async {
    texts.add(text);
    final g = gate;
    if (g != null) await g.future;
    final words = text.split(' ').length;
    return SynthAudio(Uint8List(words * 3200 * 2), 16000, 5);
  }
}

Uint8List frame(double amp) {
  final b = ByteData(1024);
  for (var i = 0; i < 512; i++) {
    b.setInt16(i * 2, ((i.isEven ? amp : -amp) * 32767).round(), Endian.little);
  }
  return b.buffer.asUint8List();
}

class Rig {
  Rig() {
    convo = LiveConversation(
      engine: engine,
      detector: vad,
      synth: synth,
      locale: 'en-PH',
      onUtterance: (t, v) async {
        sent.add(t);
        voices.add(v);
      },
      onBargeIn: (heard) async {
        barged.add(heard);
        await cancelGate?.future;
        events.add('cancelled');
      },
      onState: states.add,
      onTimeline: timelines.add,
    );
  }
  final engine = FakeEngine();
  final vad = FakeVad();
  final synth = FakeSynth();
  late final LiveConversation convo;
  final sent = <String>[], barged = <String>[], events = <String>[];
  final voices = <Map<String, dynamic>>[];
  final states = <LiveVoiceState>[];
  final timelines = <VoiceTimeline>[];
  Completer<void>? cancelGate;

  void frames(int n, {double amp = .1, bool voice = false, bool strict = false}) {
    vad.voice = voice;
    vad.strict = strict;
    for (var i = 0; i < n; i++) {
      convo.feedFrame(frame(amp));
    }
  }

  /// The user says [words] and stops; the recogniser returns them.
  Future<void> userSays(String words) async {
    frames(4, amp: .01); // quiet room: pre-roll
    frames(15, amp: .2, voice: true);
    await pumpEventQueue();
    engine.emit({'type': 'rready'});
    engine.emit({'type': 'partial', 'texts': [words]});
    frames(40, amp: .005);
    await pumpEventQueue();
    engine.emit({'type': 'final', 'texts': [words, '$words?'], 'confidence': .91});
    await pumpEventQueue();
  }
}

void main() {
  group('SpeechChunker', () {
    test('first chunk is short and early, later chunks are sentences, nothing lost', () {
      const text = 'Sure, I can help with that. Your next meeting is with Dr. Reyes at 3:30 PM today. It costs ₱4,250.75 in total. Anything else?';
      final c = SpeechChunker();
      final out = <String>[];
      for (final ch in text.split('')) {
        out.addAll(c.add(ch));
      }
      out.addAll(c.finish());
      expect(out.first, 'Sure, I can help with that.');
      expect(out[1], 'Your next meeting is with Dr. Reyes at 3:30 PM today.');
      expect(out[2], 'It costs ₱4,250.75 in total.');
      expect(out.last, 'Anything else?');
      expect(out.join(' '), text);
    });

    test('a first clause after four words starts speech before the sentence ends', () {
      final c = SpeechChunker();
      expect(c.add('Okay, let me check your calendar, '), ['Okay, let me check your calendar,']);
      expect(c.add('then I will look at email'), isEmpty);
    });

    test('does not split numbers across streamed pieces or at abbreviations and initials', () {
      final c = SpeechChunker();
      expect(c.add('The rate is 4.'), isEmpty);
      expect(c.add('5 percent, e.g. for J. Cruz and Mr. Lim. '), ['The rate is 4.5 percent,', 'e.g. for J. Cruz and Mr. Lim.']);
    });

    test('a run-on without punctuation is cut at the word cap', () {
      final c = SpeechChunker();
      final out = c.add('one two three four five six seven eight nine ten eleven twelve ');
      expect(out, ['one two three four five six seven eight nine ten']);
    });

    test('reset drops unspoken text', () {
      final c = SpeechChunker()..add('Half a sent');
      c.reset();
      expect(c.finish(), isEmpty);
    });
  });

  group('normalizeForSpeech', () {
    test('pesos, dates, times, percent and names', () {
      expect(normalizeForSpeech('Total ₱4,250.75, due Nov. 28.'), 'Total four thousand two hundred fifty pesos and seventy-five centavos, due November twenty-eighth.');
      expect(normalizeForSpeech('Meet at 3:30 PM with Dr. Reyes.'), 'Meet at three thirty P M with Doctor Reyes.');
      expect(normalizeForSpeech('Sales grew 15% in 2026.'), 'Sales grew fifteen percent in twenty twenty-six.');
      expect(normalizeForSpeech('PHP 1,000 sent via Qline'), 'one thousand pesos sent via Q line');
      expect(normalizeForSpeech('It is 10:00.'), "It is ten o'clock.");
      expect(normalizeForSpeech('Call 09171234567'), 'Call zero nine one seven one two three four five six seven');
      expect(normalizeForSpeech('2026-11-28'), 'November twenty-eighth twenty twenty-six');
    });

    test('strips markdown, links and emoji', () {
      expect(normalizeForSpeech('**Done** 🎉 see [the doc](https://x.y/z) or https://a.b'), 'Done see the doc or the link');
      expect(normalizeForSpeech('- first item\n- second item'), 'first item second item');
    });

    test('number words', () {
      expect(numberWords(0), 'zero');
      expect(numberWords(1001), 'one thousand one');
      expect(numberWords(2500000), 'two million five hundred thousand');
      expect(ordinalWords(1), 'first');
      expect(ordinalWords(22), 'twenty-second');
      expect(ordinalWords(30), 'thirtieth');
      expect(yearWords(2005), 'two thousand five');
    });
  });

  test('live end of turn waits longer after a dangling word', () {
    expect(liveEndpointMs('and'), greaterThan(liveEndpointMs('Schedule a call with Ana tomorrow at nine.')));
    expect(liveEndpointMs('Schedule a call with Ana tomorrow at nine.'), inInclusiveRange(450, 2200));
  });

  group('LiveConversation', () {
    test('a user turn: speech starts the recogniser with pre-roll, silence ends it, words are sent as live voice', () async {
      final r = Rig();
      await r.convo.start();
      await r.userSays('what is on my calendar');
      expect(r.engine.calls, containsAllInOrder(['start', 'listen:inject', 'endListen']));
      expect(r.engine.preRoll!.length, greaterThan(1024 * 4)); // the quiet frames before detection are included
      expect(r.sent, ['what is on my calendar']);
      expect(r.voices.single['mode'], 'live');
      expect(r.voices.single['lang'], 'en-PH');
      expect(r.voices.single['alternates'], ['what is on my calendar?']);
      expect(r.convo.state, LiveVoiceState.thinking);
    });

    test('a streamed reply is synthesised and queued while it is still arriving, in order', () async {
      final r = Rig();
      await r.convo.start();
      r.convo.beginReply('run1');
      r.convo.say('run1', 'Sure, let me look at that. ');
      await pumpEventQueue();
      expect(r.synth.texts, ['Sure, let me look at that.']); // before the reply finished
      expect(r.engine.played, [0]);
      r.convo.say('run1', 'You have two meetings. The first is at nine.');
      await pumpEventQueue();
      r.convo.replyDone('run1', timing: {'firstTokenMs': 400, 'totalMs': 2100});
      await pumpEventQueue();
      expect(r.engine.played, [0, 1, 2]);
      r.engine.emit({'type': 'started', 'seq': 0});
      expect(r.convo.state, LiveVoiceState.speaking);
      r.engine.emit({'type': 'ended', 'seq': 0});
      r.engine.emit({'type': 'started', 'seq': 1});
      r.engine.emit({'type': 'ended', 'seq': 1});
      r.engine.emit({'type': 'started', 'seq': 2});
      r.engine.emit({'type': 'ended', 'seq': 2});
      r.engine.emit({'type': 'drained', 'seq': 2});
      expect(r.convo.state, LiveVoiceState.listening);
    });

    test('barge-in: stops the voice at once, flushes, cancels with what was heard, ignores the old reply', () async {
      final r = Rig();
      await r.convo.start();
      r.convo.beginReply('run1');
      r.convo.say('run1', 'Your next meeting is with Ana. It starts at nine and runs an hour. ');
      await pumpEventQueue();
      r.engine.emit({'type': 'started', 'seq': 0});
      r.engine.emit({'type': 'ended', 'seq': 0});
      r.engine.emit({'type': 'started', 'seq': 1});
      // Half of chunk 1 ("It starts at nine and runs an hour." = 8 words, 1600 ms) was heard.
      r.engine.flushResult = (seq: 1, heardMs: 800, wasPlaying: true);
      r.frames(10, amp: .005); // echo only
      expect(r.engine.calls.contains('flush'), isFalse);
      r.frames(8, amp: .3, voice: true, strict: true); // 256 ms of clear speech over the voice
      await pumpEventQueue();
      expect(r.engine.calls, containsAllInOrder(['flush', 'listen:inject']));
      expect(r.engine.calls.indexOf('flush'), lessThan(r.engine.calls.indexOf('listen:inject')));
      expect(r.convo.state, LiveVoiceState.interrupted);
      expect(r.barged, isEmpty); // not yet confirmed
      r.engine.emit({'type': 'partial', 'texts': ['wait move it to ten']});
      await pumpEventQueue();
      expect(r.barged, ['Your next meeting is with Ana. It starts at nine']);
      // The old run's late tokens are dropped.
      final playedBefore = [...r.engine.played];
      r.convo.say('run1', 'More text that should never be spoken. ');
      await pumpEventQueue();
      expect(r.engine.played, playedBefore);
      r.frames(40, amp: .005);
      await pumpEventQueue();
      r.engine.emit({'type': 'final', 'texts': ['wait move it to ten']});
      await pumpEventQueue();
      expect(r.sent, ['wait move it to ten']);
    });

    test('the echo of its own words does not confirm an interruption, and a false alarm resumes', () async {
      final r = Rig();
      await r.convo.start();
      r.convo.beginReply('run1');
      r.convo.say('run1', 'Here is your summary for today. ');
      await pumpEventQueue();
      r.engine.emit({'type': 'started', 'seq': 0});
      r.engine.flushResult = (seq: 0, heardMs: 300, wasPlaying: true);
      r.frames(8, amp: .3, voice: true, strict: true);
      await pumpEventQueue();
      expect(r.engine.calls, contains('flush'));
      r.engine.emit({'type': 'partial', 'texts': ['here is your summary']}); // echo leaking through
      await pumpEventQueue();
      expect(r.barged, isEmpty);
      r.frames(50, amp: .005); // silence for ~1.6 s
      await pumpEventQueue();
      expect(r.engine.calls, contains('cancelListen'));
      expect(r.barged, isEmpty);
      expect(r.engine.played.where((s) => s == 0).length, 2); // chunk 0 replayed from its start
      expect(r.timelines.single.falseAlarm, isTrue);
    });

    test('quiet echo while speaking never triggers barge-in', () async {
      final r = Rig();
      await r.convo.start();
      r.convo.beginReply('run1');
      r.convo.say('run1', 'A long answer is playing now. ');
      await pumpEventQueue();
      r.engine.emit({'type': 'started', 'seq': 0});
      r.frames(60, amp: .01, voice: true, strict: false); // the normal detector fires on echo; the strict one does not
      r.frames(5, amp: .3, voice: true, strict: true); // 160 ms: shorter than the hold
      r.frames(5, amp: .005);
      await pumpEventQueue();
      expect(r.engine.calls, isNot(contains('flush')));
    });

    test('speech that arrives after the reply was cancelled is synthesised but never played (stale audio)', () async {
      final r = Rig();
      await r.convo.start();
      r.convo.beginReply('run1');
      r.synth.gate = Completer<void>();
      r.convo.say('run1', 'This chunk is still being made. ');
      await pumpEventQueue();
      r.engine.flushResult = (seq: -1, heardMs: 0, wasPlaying: false);
      // The user talks while Qline is still thinking (nothing audible yet).
      r.frames(4, amp: .2, voice: true);
      await pumpEventQueue();
      r.engine.emit({'type': 'partial', 'texts': ['actually never mind']});
      await pumpEventQueue();
      expect(r.barged, ['']);
      r.synth.gate!.complete();
      await pumpEventQueue();
      expect(r.engine.played, isEmpty);
    });

    test('the next turn is sent only after the interrupted reply was cancelled', () async {
      final r = Rig();
      await r.convo.start();
      r.cancelGate = Completer<void>();
      r.convo.beginReply('run1');
      r.convo.say('run1', 'Okay, here is the plan. ');
      await pumpEventQueue();
      r.engine.emit({'type': 'started', 'seq': 0});
      r.frames(8, amp: .3, voice: true, strict: true);
      await pumpEventQueue();
      r.engine.emit({'type': 'partial', 'texts': ['no send it to Ben']});
      r.frames(40, amp: .005);
      await pumpEventQueue();
      r.engine.emit({'type': 'final', 'texts': ['no send it to Ben']});
      await pumpEventQueue();
      expect(r.sent, isEmpty);
      r.cancelGate!.complete();
      await pumpEventQueue();
      expect(r.events, ['cancelled']);
      expect(r.sent, ['no send it to Ben']);
    });

    test('a recogniser that cannot use the shared microphone falls back to its own', () async {
      final r = Rig();
      await r.convo.start();
      r.frames(4, amp: .2, voice: true);
      await pumpEventQueue();
      r.engine.emit({'type': 'rerror', 'code': 5});
      await pumpEventQueue();
      expect(r.engine.calls.where((c) => c.startsWith('listen')), ['listen:inject', 'listen:legacy']);
      expect(r.convo.injecting, isFalse);
      await r.convo.stop();
    });

    test('ending the conversation stops everything and ignores late events', () async {
      final r = Rig();
      await r.convo.start();
      r.convo.beginReply('run1');
      r.convo.say('run1', 'Something to say now. ');
      await pumpEventQueue();
      await r.convo.stop();
      expect(r.engine.calls.last, 'stop');
      expect(r.convo.state, LiveVoiceState.off);
      r.engine.emit({'type': 'started', 'seq': 0});
      expect(r.convo.state, LiveVoiceState.off);
    });

    test('a stop phrase ends the conversation instead of being sent', () async {
      var ended = false;
      final e = FakeEngine();
      final c = LiveConversation(engine: e, detector: FakeVad(), synth: FakeSynth(), onUtterance: (_, _) async => fail('sent'), onBargeIn: (_) async {}, onEnd: () => ended = true);
      await c.start();
      final vad = c.detector as FakeVad;
      vad.voice = true;
      for (var i = 0; i < 10; i++) {
        c.feedFrame(frame(.2));
      }
      await pumpEventQueue();
      e.emit({'type': 'final', 'texts': ['stop listening']});
      await pumpEventQueue();
      expect(ended, isTrue);
    });

    test('timelines record when audio started relative to the end of the turn', () async {
      final r = Rig();
      await r.convo.start();
      await r.userSays('hello');
      r.convo.beginReply('run1');
      r.convo.say('run1', 'Hi there, how can I help? ');
      await pumpEventQueue();
      r.engine.emit({'type': 'started', 'seq': 0});
      r.convo.replyDone('run1', timing: {'firstTokenMs': 300});
      r.engine.emit({'type': 'ended', 'seq': 0});
      r.engine.emit({'type': 'drained', 'seq': 0});
      final t = r.timelines.single;
      expect(t.marks.keys, containsAll(['speech', 'partial', 'endpoint', 'final', 'sent', 'firstSay', 'synthStart', 'synthDone', 'audio']));
      expect(t.between('endpoint', 'audio'), isNotNull);
      expect(t.server, {'firstTokenMs': 300});
    });
  });

  test('PCM conversion round-trips', () {
    final f = Float32List.fromList([0, .5, -.5, 1, -1]);
    final back = pcm16ToFloat(floatToPcm16(f));
    for (var i = 0; i < f.length; i++) {
      expect(back[i], closeTo(f[i], .001));
    }
    expect(rms(Float32List.fromList([.5, -.5])), closeTo(.5, 1e-9));
  });

  test('status lines and timing summaries never invent numbers', () {
    for (final st in LiveVoiceState.values) {
      expect(liveMessage(st), startsWith('Live'));
    }
    var clock = 0;
    final t = VoiceTimeline('turn', clock: () => clock);
    clock = 100;
    t.mark('endpoint');
    clock = 900;
    t.mark('audio');
    final line = describeTimeline(t);
    expect(line, contains('800 ms'));
    expect(line, contains('AI first words –')); // not measured, so not guessed
    final b = VoiceTimeline('barge', clock: () => clock)..mark('detect');
    clock = 960;
    b.mark('stopped');
    expect(describeTimeline(b), contains('stopped in 60 ms'));
  });

  test('Stop / tap: interruptNow flushes, returns what was heard and drops the old reply', () async {
    final r = Rig();
    await r.convo.start();
    r.convo.beginReply('run1');
    r.convo.say('run1', 'Your next meeting is with Ana. It starts at nine and runs an hour. ');
    await pumpEventQueue();
    r.engine.emit({'type': 'started', 'seq': 0});
    r.engine.flushResult = (seq: 0, heardMs: 10000, wasPlaying: true);
    final heard = await r.convo.interruptNow();
    expect(heard, 'Your next meeting is with Ana.');
    expect(r.engine.calls, contains('flush'));
    expect(r.convo.speaking, isFalse);
    final played = [...r.engine.played];
    r.convo.say('run1', 'Late words. ');
    await pumpEventQueue();
    expect(r.engine.played, played);
    await r.convo.stop();
  });
}
