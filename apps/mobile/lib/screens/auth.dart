import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/core_painter.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key});
  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeState();
}

class _WelcomeState extends ConsumerState<WelcomeScreen> {
  bool _signUp = false;
  bool _busy = false;
  bool _hide = true;
  String? _error;
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController(), _email = TextEditingController(), _pass = TextEditingController();

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final s = ref.read(sessionProvider.notifier);
    try {
      if (_signUp) {
        await s.signUp(_name.text, _email.text, _pass.text);
      } else {
        await s.signIn(_email.text, _pass.text);
      }
    } on ApiException catch (e) {
      setState(() => _error = e.status == 401 ? 'That email and password don\'t match.' : e.message);
    } catch (_) {
      setState(() => _error = 'Something went wrong. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final reduce = ref.watch(prefsProvider).reduceMotion;
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(builder: (context, box) {
          return SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: box.maxHeight),
              child: Form(
                key: _form,
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  const SizedBox(height: 20),
                  Row(children: [const QMark(size: 26), const SizedBox(width: 10), Text('Qline', style: qs(18, w: FontWeight.w600, c: q.text))]),
                  SizedBox(height: 180, child: ExcludeSemantics(child: EnergyCore(state: CoreState.idle, reduceMotion: reduce, compact: true, background: false))),
                  Text(_signUp ? 'Set up your business OS' : 'Welcome back', style: Theme.of(context).textTheme.displaySmall),
                  const SizedBox(height: 6),
                  Text(_signUp ? 'One place for your work, your team of AI agents, and the approvals that keep you in charge.' : 'Sign in to pick up where you left off.', style: qs(15, c: q.text2)),
                  const SizedBox(height: 24),
                  if (_signUp) ...[
                    TextFormField(controller: _name, textInputAction: TextInputAction.next, autofillHints: const [AutofillHints.name], decoration: const InputDecoration(labelText: 'Your name'), validator: (v) => (v ?? '').trim().isEmpty ? 'Enter your name' : null),
                    const SizedBox(height: 12),
                  ],
                  TextFormField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    autofillHints: const [AutofillHints.email],
                    decoration: const InputDecoration(labelText: 'Email'),
                    validator: (v) => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch((v ?? '').trim()) ? null : 'Enter a valid email',
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _pass,
                    obscureText: _hide,
                    autofillHints: [_signUp ? AutofillHints.newPassword : AutofillHints.password],
                    onFieldSubmitted: (_) => _submit(),
                    decoration: InputDecoration(
                      labelText: 'Password',
                      helperText: _signUp ? 'At least 10 characters' : null,
                      suffixIcon: IconButton(tooltip: _hide ? 'Show password' : 'Hide password', icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _hide = !_hide)),
                    ),
                    validator: (v) => (v ?? '').length < (_signUp ? 10 : 1) ? (_signUp ? 'Use at least 10 characters' : 'Enter your password') : null,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Semantics(liveRegion: true, child: Row(children: [Icon(Icons.error_outline, size: 16, color: q.bad), const SizedBox(width: 6), Expanded(child: Text(_error!, style: qs(13, c: q.bad)))])),
                  ],
                  const SizedBox(height: 20),
                  QButton(_signUp ? 'Create account' : 'Sign in', kind: QBtn.halo, expand: true, busy: _busy, onPressed: _submit),
                  const SizedBox(height: 10),
                  Tooltip(
                    message: 'Google sign-in needs OAuth credentials that are not configured on this server yet.',
                    child: QButton('Continue with Google — not configured', icon: Icons.block, expand: true, onPressed: null),
                  ),
                  const SizedBox(height: 12),
                  TextButton(
                    onPressed: () => setState(() {
                      _signUp = !_signUp;
                      _error = null;
                    }),
                    child: Text(_signUp ? 'Already have an account? Sign in' : 'New to Qline? Create an account', style: qs(14, w: FontWeight.w600, c: q.text)),
                  ),
                  const SizedBox(height: 16),
                ]),
              ),
            ),
          );
        }),
      ),
    );
  }
}

class OrgSetupScreen extends ConsumerStatefulWidget {
  const OrgSetupScreen({super.key});
  @override
  ConsumerState<OrgSetupScreen> createState() => _OrgSetupState();
}

class _OrgSetupState extends ConsumerState<OrgSetupScreen> {
  bool _join = false, _busy = false;
  String? _error;
  final _c = TextEditingController();

  Future<void> _go() async {
    final v = _c.text.trim();
    if (v.isEmpty) return setState(() => _error = _join ? 'Enter the invite code' : 'Enter your business name');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final s = ref.read(sessionProvider.notifier);
      _join ? await s.joinOrg(v) : await s.createOrg(v);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    return Scaffold(
      appBar: AppBar(actions: [TextButton(onPressed: () => ref.read(sessionProvider.notifier).signOut(), child: Text('Sign out', style: qs(14, c: q.text2)))]),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          Text(_join ? 'Join your team' : 'Name your business', style: Theme.of(context).textTheme.displaySmall),
          const SizedBox(height: 8),
          Text(_join ? 'Paste the invite code a teammate shared with you.' : 'You\'ll be the owner. Your AI agents start paused on anything risky until you approve it.', style: qs(15, c: q.text2)),
          const SizedBox(height: 24),
          SegmentedButton<bool>(
            segments: const [ButtonSegment(value: false, label: Text('Create'), icon: Icon(Icons.add_business_outlined)), ButtonSegment(value: true, label: Text('Join'), icon: Icon(Icons.group_add_outlined))],
            selected: {_join},
            onSelectionChanged: (s) => setState(() {
              _join = s.first;
              _error = null;
              _c.clear();
            }),
          ),
          const SizedBox(height: 20),
          TextField(controller: _c, autofocus: true, textCapitalization: _join ? TextCapitalization.none : TextCapitalization.words, decoration: InputDecoration(labelText: _join ? 'Invite code' : 'Business name', errorText: _error), onSubmitted: (_) => _go()),
          const SizedBox(height: 20),
          QButton(_join ? 'Join organisation' : 'Create organisation', kind: QBtn.halo, expand: true, busy: _busy, onPressed: _go),
        ]),
      ),
    );
  }
}
