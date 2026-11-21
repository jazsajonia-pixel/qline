// UX audit 2026-11-21 (docs/29): Flutter's accessibility guidelines (Android tap targets, labelled tap targets,
// WCAG text contrast) on the main screens with realistic data, plus layout at 1.3× and 2× text.
import 'dart:collection';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:material_ui/material_ui.dart';
import 'package:qline/screens/auth.dart';
import 'package:qline/screens/settings.dart';
import 'package:qline/screens/business.dart';
import 'package:qline/screens/home.dart';
import 'package:qline/screens/work.dart';
import 'package:qline/screens/approvals.dart';
import 'package:qline/screens/leads.dart';
import 'package:qline/screens/integrations.dart';
import 'package:qline/screens/autonomy.dart';
import 'package:qline/screens/content.dart';
import 'package:qline/screens/legal.dart';
import 'package:qline/ui/widgets.dart';
import 'package:qline/ui/theme.dart';
import 'v17_content_test.dart' show Server, app, settle, loadFonts;

final now = DateTime.now().toUtc();
String ago(int m) => now.subtract(Duration(minutes: m)).toIso8601String();
final approval = {'id': 'a1', 'action': 'email.send', 'risk': 'medium', 'status': 'pending', 'requester_name': 'Sales agent', 'requester_kind': 'agent', 'reason': 'Reply to a new lead asking for a quote', 'preview': {'to': 'maria@cafe.ph', 'subject': 'Your quote for 50 shirts'}, 'created_at': ago(12), 'expires_at': now.add(const Duration(hours: 20)).toIso8601String(), 'canDecide': true};
final lead = {'id': 'l1', 'from_email': 'maria@cafe.ph', 'from_name': 'Maria Santos', 'subject': 'Quote for 50 printed shirts by Friday', 'snippet': 'Hi! We need 50 shirts with our logo for an event this Friday. Can you send a price?', 'summary': 'Wants 50 printed shirts by Friday', 'reason': 'Deadline this week', 'urgency': 'urgent', 'is_lead': true, 'source': 'gmail', 'received_at': ago(30), 'created_at': ago(29), 'classified_by': 'ai', 'contact_name': null};
final data = <String, Object?>{
  '/dashboard': {'businessName': 'Mara Prints', 'configured': true, 'asOf': ago(1), 'widgets': [{'key': 'open_tasks', 'label': 'Open tasks', 'value': 7, 'source': 'tasks'}, {'key': 'overdue_tasks', 'label': 'Overdue', 'value': 2, 'source': 'tasks'}, {'key': 'leads', 'label': 'New leads', 'value': 3, 'source': 'lead inbox'}, {'key': 'approvals', 'label': 'Waiting', 'value': 1, 'source': 'approvals'}], 'focus': [], 'approvals': [approval], 'activity': [{'title': 'Created task “Print proof for Maria”', 'actor_kind': 'agent', 'at': ago(5), 'action': 'task.create'}], 'counts': {'urgent': 1, 'leads': 3, 'today': 2}},
  '/approvals': {'items': [approval, {...approval, 'id': 'a2', 'action': 'slack.post', 'risk': 'low', 'requester_name': 'Ana', 'requester_kind': 'user', 'reason': 'Daily summary to #sales'}]},
  '/leads/inbox': {'items': [lead, {...lead, 'id': 'l2', 'urgency': 'normal', 'from_name': 'Jun Reyes', 'subject': 'Do you deliver to Tagum?', 'summary': 'Asks about delivery area'}], 'counts': {'urgent': 1, 'leads': 2, 'ignored': 4}},
  '/tasks': {'items': [{'id': 't1', 'title': 'Print proof for Maria', 'status': 'todo', 'priority': 'high', 'due_at': now.add(const Duration(days: 1)).toIso8601String(), 'created_at': ago(60), 'source_kind': 'agent', 'description': 'Use the blue logo'}, {'id': 't2', 'title': 'Order more ink', 'status': 'in_progress', 'priority': 'medium', 'due_at': ago(1440), 'created_at': ago(3000)}, {'id': 't3', 'title': 'Send invoice to Jun', 'status': 'done', 'priority': 'low', 'completed_at': ago(100), 'created_at': ago(4000)}]},
  '/projects': {'items': [{'id': 'p1', 'name': 'Fiesta orders', 'status': 'active', 'task_count': 8, 'done_count': 3}]},
  '/integrations': {'canSetup': true, 'providers': [{'id': 'google', 'name': 'Google', 'registered': true, 'connection': {'status': 'active', 'accountEmail': 'mara@gmail.com', 'accountName': 'Mara', 'features': ['gmail', 'calendar'], 'connectedAt': ago(5000), 'lastSyncAt': ago(3)}}, {'id': 'slack', 'name': 'Slack', 'registered': true, 'connection': null}, {'id': 'microsoft', 'name': 'Microsoft 365', 'registered': false, 'connection': null}], 'other': [{'name': 'Stripe', 'detail': 'Payments and invoices', 'status': 'available'}]},
  '/me/sessions': {'items': [{'id': 's1', 'current': true, 'userAgent': 'Qline Android', 'ipAddress': '203.0.113.5', 'createdAt': ago(100), 'expiresAt': now.add(const Duration(days: 29)).toIso8601String()}, {'id': 's2', 'current': false, 'userAgent': 'Chrome on Windows', 'ipAddress': '198.51.100.7', 'createdAt': ago(9000), 'expiresAt': now.add(const Duration(days: 20)).toIso8601String()}]},
};

class Fallback extends MapBase<String, Object? Function(http.Request)> {
  @override
  Object? Function(http.Request)? operator [](Object? k) {
    final path = (k as String).split(' ').last;
    if (k.startsWith('GET ') && data.containsKey(path)) return (_) => data[path];
    return (_) => {'items': <Object>[], 'connected': false, 'pages': <Object>[], 'posts': <Object>[]};
  }
  @override
  void operator []=(String k, v) {}
  @override
  void clear() {}
  @override
  Iterable<String> get keys => const [];
  @override
  remove(Object? k) => null;
}

final screens = <String, Widget Function()>{
  'welcome': () => const WelcomeScreen(),
  'org_setup': () => const OrgSetupScreen(),
  'settings': () => const SettingsScreen(),
  'sessions': () => const SessionsScreen(),
  'business': () => const Scaffold(body: BusinessScreen()),
  'home': () => Scaffold(body: HomeScreen(onTab: (_) {})),
  'work': () => const WorkScreen(),
  'approvals': () => const ApprovalsScreen(),
  'leads': () => const LeadInboxScreen(),
  'integrations': () => const IntegrationsScreen(),
  'autonomy': () => const AutonomyScreen(),
  'content': () => const ContentStudioScreen(),
  'terms': () => const LegalScreen(LegalDoc.terms),
  'delete_account': () => const DeleteAccountScreen(),
};

String first(Object e) => e.toString().replaceAll('\n', ' ').substring(0, e.toString().length.clamp(0, 900));

void main() {
  setUpAll(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (c) async => null);
    await loadFonts();
  });
  for (final e in screens.entries) {
    for (final (light, scale) in [(false, 1.0), (true, 1.0), (false, 1.3), (true, 2.0)]) {
      final tag = '${e.key}_${light ? 'light' : 'dark'}_${scale}x';
      testWidgets(tag, (t) async {
        t.view.physicalSize = const Size(360 * 3, 780 * 3);
        t.view.devicePixelRatio = 3;
        addTearDown(t.view.reset);
        final h = t.ensureSemantics();
        final out = <String>[];
        final prev = FlutterError.onError;
        FlutterError.onError = (d) => out.add('LAYOUT: ${d.exceptionAsString().split('\n').first}');
        await t.pumpWidget(app(Server(Fallback()), e.value(), light: light, textScale: scale));
        await t.runAsync(() => Future.delayed(const Duration(milliseconds: 300)));
        await settle(t);
        await t.pump(const Duration(seconds: 1));
        final guidelines = scale == 1.0 ? <(String, AccessibilityGuideline)>[('TAP', androidTapTargetGuideline), ('LABEL', labeledTapTargetGuideline)] : <(String, AccessibilityGuideline)>[];
        for (final (name, g) in guidelines) {
          try {
            final r = await t.runAsync(() async => await g.evaluate(t));
            if (r != null && !r.passed) out.add('$name: ${(r.reason ?? '').replaceAll('\n', ' ⏎ ')}');
          } catch (x) {
            out.add('$name-ERR ${first(x)}');
          }
        }
        if (scale == 1.0) {
          try {
            await expectLater(t, meetsGuideline(textContrastGuideline));
          } on TestFailure catch (x) {
            out.add('CONTRAST: ${x.message?.split('Which: ').last.replaceAll('\n', ' ⏎ ')}');
          }
        }
        FlutterError.onError = prev;
        h.dispose();
        t.takeException();
        expect(out, isEmpty, reason: tag);
      });
    }
  }

  group('shared widgets', () {
    Widget host(Widget child, {double width = 360}) => ProviderScope(child: MaterialApp(theme: buildTheme(false), home: Scaffold(body: Center(child: SizedBox(width: width, child: child)))));

    testWidgets('QButton gives haptic feedback for decisions and destructive actions only', (t) async {
      final calls = <String>[];
      t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (c) async {
        if (c.method == 'HapticFeedback.vibrate') calls.add(c.arguments as String);
        return null;
      });
      addTearDown(() => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      var pressed = 0;
      await t.pumpWidget(host(Column(children: [
        QButton('Approve', kind: QBtn.halo, onPressed: () => pressed++),
        QButton('Delete', kind: QBtn.destructive, onPressed: () => pressed++),
        QButton('Cancel', onPressed: () => pressed++),
      ])));
      for (final l in ['Approve', 'Delete', 'Cancel']) {
        await t.tap(find.text(l));
        await t.pump(const Duration(milliseconds: 200));
      }
      expect(pressed, 3);
      expect(calls, ['HapticFeedbackType.lightImpact', 'HapticFeedbackType.mediumImpact']);
    });

    testWidgets('a tappable QCard reads its content as one labelled button', (t) async {
      final h = t.ensureSemantics();
      await t.pumpWidget(host(QCard(onTap: () {}, child: Semantics(container: true, child: const Text('Drive folders ready')))));
      await expectLater(t, meetsGuideline(labeledTapTargetGuideline));
      h.dispose();
    });

    testWidgets('EdgeFade fades only when the row overflows', (t) async {
      Widget row(int n) => host(EdgeFade(child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [for (var i = 0; i < n; i++) const SizedBox(width: 100, height: 40)]))));
      await t.pumpWidget(row(2));
      await t.pump();
      expect(find.byType(ShaderMask), findsNothing);
      await t.pumpWidget(row(8));
      await t.pump();
      await t.pump();
      expect(find.byType(ShaderMask), findsOneWidget);
    });
  });
}
