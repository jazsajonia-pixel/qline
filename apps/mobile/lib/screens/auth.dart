import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../ui/core_painter.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'legal.dart';

class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key});
  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeState();
}

class _WelcomeState extends ConsumerState<WelcomeScreen> with WidgetsBindingObserver {
  bool _signUp = false;
  bool _busy = false;
  bool _google = false;
  String? _nonce;
  Timer? _poll;
  DateTime? _pollUntil;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // Coming back from the browser: check right away instead of waiting for the next poll.
    if (s == AppLifecycleState.resumed && _nonce != null) _checkGoogle();
  }

  Future<void> _startGoogle() async {
    setState(() {
      _google = true;
      _error = null;
    });
    final rnd = Random.secure();
    final nonce = base64Url.encode(List<int>.generate(32, (_) => rnd.nextInt(256))).replaceAll('=', '');
    try {
      final r = await ref.read(sessionProvider.notifier).api.post('/google-signin/start', {'nonce': nonce}) as Map;
      _nonce = nonce;
      _pollUntil = DateTime.now().add(const Duration(minutes: 5));
      final ok = await launchUrl(Uri.parse(r['url'] as String), mode: LaunchMode.externalApplication);
      if (!ok) throw ApiException(0, 'LAUNCH', 'Could not open the browser');
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 2), (_) => _checkGoogle());
    } on ApiException catch (e) {
      _stopGoogle(e.detail ?? e.message);
    } catch (_) {
      _stopGoogle('Google sign-in could not start. Try again.');
    }
  }

  bool _checking = false;
  Future<void> _checkGoogle() async {
    final nonce = _nonce;
    if (nonce == null || _checking) return;
    if (_pollUntil != null && DateTime.now().isAfter(_pollUntil!)) return _stopGoogle('Google sign-in timed out. Try again.');
    _checking = true;
    final s = ref.read(sessionProvider.notifier);
    try {
      final r = await s.api.post('/google-signin/finish', {'nonce': nonce});
      if (r is Map && r['token'] is String) {
        _poll?.cancel();
        _nonce = null;
        await s.signInWithToken(r['token'] as String);
        if (mounted) setState(() => _google = false);
      }
    } on ApiException catch (e) {
      if (e.status != 0) _stopGoogle(e.detail ?? e.message);
    } finally {
      _checking = false;
    }
  }

  void _stopGoogle([String? error]) {
    _poll?.cancel();
    _nonce = null;
    if (mounted) {
      setState(() {
        _google = false;
        _error = error;
      });
    }
  }

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
                  QButton('Continue with Google', icon: Icons.account_circle_outlined, expand: true, busy: _google, onPressed: _busy || _google ? null : _startGoogle),
                  const SizedBox(height: 12),
                  // Audit 2026-11-21: both buttons can create an account, so the notice covers Google too.
                  LegalConsentText(prefix: _signUp ? 'By creating an account you agree to the ' : 'By continuing you agree to the '),
                  if (_google) ...[
                    const SizedBox(height: 8),
                    Text('Finish in your browser, then come back here.', textAlign: TextAlign.center, style: qs(13, c: q.text2)),
                    TextButton(onPressed: () => _stopGoogle(), child: Text('Cancel', style: qs(13, w: FontWeight.w600, c: q.text))),
                  ],
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
  /// 'me' (personal space, the default), 'business' or 'join'.
  String _mode = 'me';
  bool _busy = false;
  String? _error;
  final _c = TextEditingController();

  Future<void> _go() async {
    final v = _c.text.trim();
    if (_mode != 'me' && v.isEmpty) return setState(() => _error = _mode == 'join' ? 'Enter the invite code' : 'Enter your business name');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final s = ref.read(sessionProvider.notifier);
      switch (_mode) {
        case 'join':
          await s.joinOrg(v);
        case 'business':
          await s.createOrg(v);
        default:
          await s.createPersonal();
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final (title, body, action) = switch (_mode) {
      'join' => ('Join your team', 'Paste the invite code a teammate shared with you.', 'Join'),
      'business' => ('Name your business', 'You\'ll be the owner. Your AI agents start paused on anything risky until you approve it. Your personal space stays separate.', 'Create business space'),
      _ => ('Your personal space', 'Notes, goals, projects, files and your AI, just for you. You can add a business or join a team any time.', 'Start'),
    };
    return Scaffold(
      appBar: AppBar(actions: [TextButton(onPressed: () => ref.read(sessionProvider.notifier).signOut(), child: Text('Sign out', style: qs(14, c: q.text2)))]),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          Text(title, style: Theme.of(context).textTheme.displaySmall),
          const SizedBox(height: 8),
          Text(body, style: qs(15, c: q.text2)),
          const SizedBox(height: 24),
          SegmentedButton<String>(
            segments: const [
              // Audit 2026-11-21: with icons, "Business" broke onto two lines at 360 dp. Labels alone fit.
              ButtonSegment(value: 'me', label: Text('Just me', maxLines: 1, softWrap: false)),
              ButtonSegment(value: 'business', label: Text('Business', maxLines: 1, softWrap: false)),
              ButtonSegment(value: 'join', label: Text('Join', maxLines: 1, softWrap: false)),
            ],
            showSelectedIcon: false,
            selected: {_mode},
            onSelectionChanged: (s) => setState(() {
              _mode = s.first;
              _error = null;
              _c.clear();
            }),
          ),
          const SizedBox(height: 20),
          if (_mode != 'me') ...[
            TextField(
              controller: _c,
              autofocus: true,
              textCapitalization: _mode == 'join' ? TextCapitalization.none : TextCapitalization.words,
              decoration: InputDecoration(labelText: _mode == 'join' ? 'Invite code' : 'Business name', errorText: _error),
              onSubmitted: (_) => _go(),
            ),
            const SizedBox(height: 20),
          ] else if (_error != null) ...[
            Text(_error!, style: qs(13, c: q.bad)),
            const SizedBox(height: 12),
          ],
          QButton(action, kind: QBtn.halo, expand: true, busy: _busy, onPressed: _go),
        ]),
      ),
    );
  }
}
