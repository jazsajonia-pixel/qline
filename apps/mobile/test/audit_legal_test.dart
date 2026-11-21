import 'dart:convert';
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/core/api.dart';
import 'package:qline/core/session.dart';
import 'package:qline/screens/auth.dart';
import 'package:qline/screens/legal.dart';
import 'package:qline/screens/settings.dart';
import 'package:qline/ui/theme.dart';

/// Audit 2026-11-21 (docs/29): in-app Terms and Privacy, sign-up consent, account deletion request, UI fixes.

class _Signed extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false, token: 't', userName: 'Ana', email: 'ana@shop.ph', orgs: [Org('o1', 'Shop & Co', 'owner')], orgId: 'o1');
}

class _SignedOut extends SessionNotifier {
  @override
  SessionState build() => SessionState(loading: false);
}

Widget app(Widget home, {bool signedIn = true, Map<String, Object?> routes = const {}}) => ProviderScope(
      overrides: [
        apiProvider.overrideWithValue(Api(client: MockClient((r) async {
          final body = routes['${r.method} ${r.url.path.replaceFirst('/v1', '')}'];
          return body == null ? http.Response('{"title":"Not found"}', 404) : http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
        }))),
        sessionProvider.overrideWith(() => signedIn ? _Signed() : _SignedOut()),
      ],
      child: MaterialApp(theme: buildTheme(false), home: home),
    );

void phone(WidgetTester t, {double width = 360}) {
  t.view.physicalSize = Size(width * 3, 800 * 3);
  t.view.devicePixelRatio = 3;
  addTearDown(t.view.reset);
}

Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 10; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

/// Taps the TextSpan whose text is [label] inside any Text.rich on screen.
Future<void> tapSpan(WidgetTester t, String label) async {
  for (final rt in t.widgetList<RichText>(find.byType(RichText))) {
    TapGestureRecognizer? hit;
    rt.text.visitChildren((s) {
      if (s is TextSpan && s.text == label && s.recognizer is TapGestureRecognizer) hit = s.recognizer as TapGestureRecognizer;
      return hit == null;
    });
    if (hit != null) {
      hit!.onTap!();
      await settle(t);
      return;
    }
  }
  fail('No tappable "$label"');
}

void main() {
  group('legal documents', () {
    for (final name in ['terms', 'privacy']) {
      test('$name.md is bundled, versioned and has its contact', () {
        final md = File('assets/legal/$name.md').readAsStringSync();
        expect(md, startsWith('# '));
        expect(RegExp(r'^Version \d{4}-\d{2}-\d{2} · Effective ', multiLine: true).hasMatch(md), isTrue);
        expect(md, contains('chrono07g@gmail.com'));
        expect(md, contains('Davao City'));
      });
    }

    test('both documents carry the same version', () {
      String v(String n) => RegExp(r'^Version (\S+)', multiLine: true).firstMatch(File('assets/legal/$n.md').readAsStringSync())!.group(1)!;
      expect(v('terms'), v('privacy'));
    });

    test('pubspec bundles the legal folder', () {
      expect(File('pubspec.yaml').readAsStringSync(), contains('    - assets/legal/'));
    });

    test('privacy policy names every connected service and the Google Limited Use statement', () {
      final md = File('assets/legal/privacy.md').readAsStringSync();
      for (final s in ['Gmail', 'Google Drive', 'Calendar', 'Microsoft 365', 'Slack', 'Notion', 'GitHub', 'Facebook Pages', 'Stripe', 'DeepSeek', 'Singapore', '72 hours', 'Limited Use']) {
        expect(md, contains(s), reason: s);
      }
    });

    test('terms keep the liability carve-outs Philippine law requires', () {
      final md = File('assets/legal/terms.md').readAsStringSync();
      expect(md, contains('fraud, bad faith, gross negligence or wilful misconduct'));
      expect(md, contains('Davao City'));
      // Section numbers run 1..17 once each (the old website had two sections 9 and 10).
      final nums = RegExp(r'^## (\d+)\.', multiLine: true).allMatches(md).map((m) => int.parse(m.group(1)!)).toList();
      expect(nums, List.generate(nums.length, (i) => i + 1));
    });
  });

  testWidgets('LegalScreen renders the privacy policy without repeating the title', (t) async {
    phone(t);
    await t.pumpWidget(app(const LegalScreen(LegalDoc.privacy)));
    await t.runAsync(() => rootBundle.loadString('assets/legal/privacy.md'));
    await settle(t);
    expect(find.text('Privacy policy'), findsOneWidget); // app bar only
    expect(find.textContaining('Google user data', findRichText: true), findsWidgets);
    expect(t.takeException(), isNull);
  });

  testWidgets('sign-in screen shows the consent notice, and its links open the documents', (t) async {
    phone(t);
    await t.pumpWidget(app(const WelcomeScreen(), signedIn: false));
    await settle(t);
    expect(find.textContaining('By continuing you agree to the', findRichText: true), findsOneWidget);
    await t.tap(find.text('New to Qline? Create an account'));
    await settle(t);
    expect(find.textContaining('By creating an account you agree to the', findRichText: true), findsOneWidget);
    await tapSpan(t, 'Terms of service');
    expect(find.byType(LegalScreen), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('Settings lists Terms, Privacy and Delete account with a current Integrations summary', (t) async {
    phone(t);
    await t.pumpWidget(app(const SettingsScreen()));
    await settle(t);
    expect(find.text('Gmail, Drive, Calendar, Slack, Notion, GitHub and more'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Delete account'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Terms of service'), findsOneWidget);
    expect(find.text('Privacy policy'), findsOneWidget);
    await t.ensureVisible(find.text('Delete account'));
    await settle(t);
    await t.tap(find.text('Delete account'));
    await settle(t);
    expect(find.byType(DeleteAccountScreen), findsOneWidget, reason: 'route opened');
    await t.scrollUntilVisible(find.text('Email deletion request'), 200, scrollable: find.descendant(of: find.byType(DeleteAccountScreen), matching: find.byType(Scrollable)).first);
    expect(find.text('Email deletion request'), findsOneWidget);
    expect(find.textContaining('ana@shop.ph'), findsOneWidget);
  });

  test('deletion request email is addressed, prefilled and encoded for mail apps', () {
    final u = DeleteAccountScreen.requestUri('ana@shop.ph', 'Shop & Co');
    expect(u.scheme, 'mailto');
    expect(u.path, 'chrono07g@gmail.com');
    expect(u.query, isNot(contains('+')));
    expect(Uri.decodeComponent(u.query), contains('Account email: ana@shop.ph'));
    expect(Uri.decodeComponent(u.query), contains('Organisation: Shop & Co'));
  });

  testWidgets('org setup: "Business" stays on one line at 360 dp', (t) async {
    phone(t);
    await t.pumpWidget(app(const OrgSetupScreen()));
    await settle(t);
    final h = t.getSize(find.text('Business')).height;
    final one = t.getSize(find.text('Join')).height;
    expect(h, one);
    expect(t.takeException(), isNull);
  });

  testWidgets('signed-in devices: a lone device shows a note, not a disabled red button', (t) async {
    phone(t);
    await t.pumpWidget(app(const SessionsScreen(), routes: {
      'GET /me/sessions': {
        'items': [
          {'id': 's1', 'current': true, 'userAgent': 'Qline Android', 'createdAt': DateTime.now().toIso8601String(), 'expiresAt': DateTime.now().add(const Duration(days: 30)).toIso8601String()},
        ],
      },
    }));
    await settle(t);
    expect(find.text('This is the only device signed in.'), findsOneWidget);
    expect(find.text('No other devices'), findsNothing);
  });
}
