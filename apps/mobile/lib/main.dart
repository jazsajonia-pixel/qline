import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import 'core/session.dart';
import 'screens/auth.dart';
import 'screens/shell.dart';
import 'ui/core_painter.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: QlineApp()));
}

class QlineApp extends ConsumerWidget {
  const QlineApp({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final prefs = ref.watch(prefsProvider);
    final light = prefs.light;
    SystemChrome.setSystemUIOverlayStyle(light ? SystemUiOverlayStyle.dark : SystemUiOverlayStyle.light);
    return MaterialApp(
      title: 'Qline',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: prefs.reduceMotion || MediaQuery.of(context).disableAnimations),
        child: child!,
      ),
      home: const Root(),
    );
  }
}

class Root extends ConsumerWidget {
  const Root({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(sessionProvider);
    final Widget child;
    if (s.loading) {
      child = const Splash();
    } else if (!s.signedIn) {
      child = const WelcomeScreen();
    } else if (s.orgId == null) {
      child = const OrgSetupScreen();
    } else {
      child = const Shell();
    }
    return AnimatedSwitcher(duration: const Duration(milliseconds: 220), child: KeyedSubtree(key: ValueKey(child.runtimeType), child: child));
  }
}

class Splash extends StatelessWidget {
  const Splash({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [const QMark(size: 44), const SizedBox(height: 16), Text('Qline', style: qs(20, w: FontWeight.w600, c: context.q.text))])));
}
