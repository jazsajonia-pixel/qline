import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import 'core/session.dart';
import 'screens/auth.dart';
import 'screens/shell.dart';
import 'ui/core_painter.dart';
import 'ui/launch.dart';
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

class Root extends ConsumerStatefulWidget {
  const Root({super.key, this.launch = launchDuration});
  final Duration launch;
  @override
  ConsumerState<Root> createState() => _RootState();
}

class _RootState extends ConsumerState<Root> {
  late final LaunchGate _gate = LaunchGate(widget.launch)..listen(() => mounted ? setState(() {}) : null);

  @override
  void dispose() {
    _gate.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(sessionProvider);
    final Widget child;
    if (!_gate.done) {
      child = LaunchScreen(duration: widget.launch);
    } else if (s.loading) {
      child = const Splash();
    } else if (!s.signedIn) {
      child = const WelcomeScreen();
    } else if (s.orgId == null) {
      child = const OrgSetupScreen();
    } else {
      child = const Shell();
    }
    return AnimatedSwitcher(duration: const Duration(milliseconds: 380), child: KeyedSubtree(key: ValueKey(child.runtimeType), child: child));
  }
}

class Splash extends StatelessWidget {
  const Splash({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [const QMark(size: 44), const SizedBox(height: 16), Text('Qline', style: qs(20, w: FontWeight.w600, c: context.q.text))])));
}
