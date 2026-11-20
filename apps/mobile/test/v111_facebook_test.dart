import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:material_ui/material_ui.dart';
import 'package:qline/screens/facebook.dart';
import 'package:qline/ui/widgets.dart' show QButton;

import 'v17_content_test.dart' show Server, app, phone, settle, loadFonts, shots, hoursAgo;

/// v1.11 (docs/27): Facebook Pages. Review first, explicit approval, nothing posted without it.
/// Screenshots: `QLINE_SHOTS=1 flutter test test/v111_facebook_test.dart --update-goldens`
const page = {'id': 'pg1', 'pageId': '111', 'name': 'Mara Bakes', 'category': 'Bakery', 'canPost': true, 'status': 'ok'};
const hash = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

Server fb({bool video = true, Object? Function(http.Request r)? publish}) => Server({
      'GET /facebook/pages': (_) => {
            'connected': true,
            'connection': {'status': 'ok', 'accountName': 'Mara', 'canPostVideo': video},
            'pages': [
              page,
              {'id': 'pg2', 'pageId': '222', 'name': 'Old Shop', 'category': 'Shop', 'canPost': false, 'status': 'no_access'},
            ],
          },
      'GET /facebook/posts': (_) => {
            'posts': [
              {'id': 'p1', 'pageName': 'Mara Bakes', 'kind': 'text', 'message': 'Fresh ensaymada today', 'status': 'scheduled', 'scheduleAt': hoursAgo(-5), 'source': 'user', 'createdAt': hoursAgo(1)},
              {'id': 'p2', 'pageName': 'Mara Bakes', 'kind': 'photo', 'message': 'New cake', 'mediaName': 'cake.jpg', 'status': 'published', 'permalink': 'https://facebook.com/111/posts/1', 'source': 'agent', 'publishedAt': hoursAgo(2), 'createdAt': hoursAgo(2)},
              {'id': 'p3', 'pageName': 'Mara Bakes', 'kind': 'link', 'message': 'Menu', 'status': 'failed', 'error': 'Facebook says this looks like a duplicate post.', 'source': 'user', 'createdAt': hoursAgo(3)},
            ],
            'awaitingApproval': [
              {'approvalId': 'ap1', 'title': 'Post on Mara Bakes now', 'lines': ['Text: Weekend promo'], 'createdAt': hoursAgo(0)},
            ],
          },
      'POST /facebook/posts/preview': (r) => {
            'contentHash': hash,
            'preview': {
              'title': 'Post on Mara Bakes now',
              'lines': ['Page: Mara Bakes', 'Text: ${(jsonDecode(r.body) as Map)['message']}'],
            },
          },
      'POST /facebook/posts': publish ?? (r) => http.Response(jsonEncode({'post': {'id': 'p9', 'status': 'published', 'kind': 'text'}}), 201, headers: {'content-type': 'application/json'}),
      'POST /facebook/posts/p1/cancel': (_) => {'post': {'id': 'p1', 'status': 'cancelled'}},
      'POST /facebook/media': (_) => http.Response(jsonEncode({'id': 'f1', 'name': 'cake.jpg', 'kind': 'photo'}), 201, headers: {'content-type': 'application/json'}),
    });

Map<String, dynamic> bodyOf(http.Request r) => (jsonDecode(r.body) as Map).cast<String, dynamic>();

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (c) async => null);
    await loadFonts();
  });

  for (final light in [false, true]) {
    testWidgets('Facebook home: guarantees, Pages, waiting approvals and post statuses (${light ? 'light' : 'dark'}, 390 px)', (t) async {
      phone(t, height: 1600);
      final s = fb();
      await t.pumpWidget(app(s, const FacebookScreen(), light: light));
      await settle(t);
      expect(find.textContaining('Nothing is posted until you review'), findsOneWidget);
      expect(find.text('Mara Bakes'), findsOneWidget);
      expect(find.text("You can't create posts on this Page"), findsOneWidget);
      expect(find.text('Post on Mara Bakes now'), findsOneWidget);
      expect(find.text('Scheduled'), findsOneWidget);
      expect(find.text('Published'), findsOneWidget);
      expect(find.text('Failed'), findsOneWidget);
      expect(find.textContaining('duplicate post'), findsOneWidget);
      expect(find.textContaining('written by the AI'), findsOneWidget);
      expect(find.text('View on Facebook'), findsOneWidget);
      expect(t.takeException(), isNull);
      expect(s.calls.where((r) => r.method != 'GET'), isEmpty);
      if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/facebook_home_${light ? 'light' : 'dark'}.png'));
    });
  }

  testWidgets('cancelling a scheduled post asks first and sends confirm', (t) async {
    phone(t, height: 1600);
    final s = fb();
    await t.pumpWidget(app(s, const FacebookScreen()));
    await settle(t);
    await t.tap(find.text('Cancel post'));
    await settle(t);
    expect(find.text('Cancel this scheduled post?'), findsOneWidget);
    await t.tap(find.text('Cancel').first);
    await settle(t);
    expect(s.hits('POST', '/facebook/posts/p1/cancel'), isEmpty);
    await t.tap(find.text('Cancel post'));
    await settle(t);
    await t.tap(find.widgetWithText(QButton, 'Cancel post').last);
    await settle(t);
    expect(bodyOf(s.hits('POST', '/facebook/posts/p1/cancel').single), {'confirm': true});
  });

  testWidgets('text post: review sheet shows the exact post; Edit sends nothing; Approve sends confirm + hash + request key', (t) async {
    phone(t);
    final s = fb();
    await t.pumpWidget(app(s, const FacebookComposeScreen(page: page, canPostVideo: true)));
    await settle(t);
    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    expect(find.text('Write the post text first.'), findsOneWidget);
    expect(s.calls, isEmpty);

    await t.enterText(find.byKey(const Key('fb-message')), 'Bagong luto! Fresh pandesal 6 AM');
    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    expect(find.text('Text: Bagong luto! Fresh pandesal 6 AM'), findsOneWidget);
    await t.tap(find.text('Edit'));
    await settle(t);
    expect(s.hits('POST', '/facebook/posts').where((r) => r.url.path.endsWith('/facebook/posts')), isEmpty);

    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    await t.tap(find.byKey(const Key('fb-approve')));
    await settle(t);
    final sent = s.calls.where((r) => r.method == 'POST' && r.url.path.endsWith('/facebook/posts')).single;
    final b = bodyOf(sent);
    expect(b['confirm'], true);
    expect(b['contentHash'], hash);
    expect(b['pageRef'], 'pg1');
    expect(b['kind'], 'text');
    expect(b['message'], 'Bagong luto! Fresh pandesal 6 AM');
    expect((b['requestKey'] as String).length, 32);
    expect(b.containsKey('scheduleAt'), isFalse);
    expect(t.takeException(), isNull);
  });

  testWidgets('a failed publish (422) shows Facebook\'s reason and stays on the composer', (t) async {
    phone(t);
    final s = fb(publish: (_) => http.Response(jsonEncode({'code': 'FACEBOOK_DUPLICATE', 'title': 'Facebook did not post', 'detail': 'Facebook says this looks like a duplicate post.'}), 422, headers: {'content-type': 'application/json'}));
    await t.pumpWidget(app(s, const FacebookComposeScreen(page: page)));
    await settle(t);
    await t.enterText(find.byKey(const Key('fb-message')), 'Hello');
    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    await t.tap(find.byKey(const Key('fb-approve')));
    await settle(t);
    expect(find.textContaining('duplicate post'), findsOneWidget);
    expect(find.byKey(const Key('fb-review')), findsOneWidget);
  });

  testWidgets('photo post uploads the file, sends its id; video is off without publish_video; link must be https', (t) async {
    phone(t);
    pickFacebookMedia = (video) async => (name: 'cake.jpg', bytes: Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    addTearDown(() => pickFacebookMedia = (video) async => null);
    final s = fb();
    await t.pumpWidget(app(s, const FacebookComposeScreen(page: page)));
    await settle(t);
    expect(find.textContaining('Video needs the "publish video" permission'), findsOneWidget);

    await t.tap(find.text('Link'));
    await settle(t);
    await t.enterText(find.byKey(const Key('fb-link')), 'ftp://nope');
    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    expect(find.text('Add a link that starts with https://.'), findsOneWidget);

    await t.tap(find.text('Photo'));
    await settle(t);
    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    expect(find.text('Choose a photo.'), findsOneWidget);
    await t.tap(find.text('Choose'));
    await settle(t);
    expect(s.hits('POST', '/facebook/media'), hasLength(1));
    expect(find.textContaining('cake.jpg'), findsOneWidget);
    await t.tap(find.byKey(const Key('fb-review')));
    await settle(t);
    final pv = bodyOf(s.hits('POST', '/facebook/posts/preview').single);
    expect(pv['kind'], 'photo');
    expect(pv['fileId'], 'f1');
    expect(pv.containsKey('link'), isFalse);
  });

  testWidgets('files over 10 MB are refused before uploading', (t) async {
    phone(t);
    pickFacebookMedia = (video) async => (name: 'big.jpg', bytes: Uint8List(fbMaxBytes + 1));
    addTearDown(() => pickFacebookMedia = (video) async => null);
    final s = fb();
    await t.pumpWidget(app(s, const FacebookComposeScreen(page: page)));
    await settle(t);
    await t.tap(find.text('Photo'));
    await settle(t);
    await t.tap(find.text('Choose'));
    await settle(t);
    expect(find.text('That file is over 10 MB. Pick a smaller one.'), findsOneWidget);
    expect(s.hits('POST', '/facebook/media'), isEmpty);
  });
}
