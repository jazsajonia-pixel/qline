import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/session.dart';
import '../ui/markdown.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

/// Audit 2026-11-21: the Terms and Privacy Policy ship inside the app (assets/legal/*.md), so they can be
/// read before signing in and offline. scripts/build-legal.mjs builds the website pages from the same files.
enum LegalDoc { terms, privacy }

const legalContact = 'chrono07g@gmail.com';

extension on LegalDoc {
  String get title => this == LegalDoc.terms ? 'Terms of service' : 'Privacy policy';
  String get asset => 'assets/legal/$name.md';
}

class LegalScreen extends StatelessWidget {
  const LegalScreen(this.doc, {super.key, this.bundle});
  final LegalDoc doc;

  /// Tests pass their own bundle; the app uses rootBundle.
  final AssetBundle? bundle;

  @override
  Widget build(BuildContext context) {
    return Page2(
      title: doc.title,
      body: FutureBuilder<String>(
        future: (bundle ?? rootBundle).loadString(doc.asset),
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('Could not open the ${doc.title.toLowerCase()}. Email $legalContact for a copy.', textAlign: TextAlign.center)));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          // The first line repeats the page title; the app bar already shows it.
          final text = snap.data!.replaceFirst(RegExp(r'^# .*\n+'), '');
          return SelectionArea(child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [MarkdownText(text)]));
        },
      ),
    );
  }
}

/// "By creating an account you agree to the Terms and Privacy Policy", with both titles tappable.
class LegalConsentText extends StatefulWidget {
  const LegalConsentText({super.key, this.prefix = 'By creating an account you agree to the '});
  final String prefix;
  @override
  State<LegalConsentText> createState() => _LegalConsentTextState();
}

class _LegalConsentTextState extends State<LegalConsentText> {
  late final _terms = TapGestureRecognizer()..onTap = () => push(context, const LegalScreen(LegalDoc.terms));
  late final _privacy = TapGestureRecognizer()..onTap = () => push(context, const LegalScreen(LegalDoc.privacy));

  @override
  void dispose() {
    _terms.dispose();
    _privacy.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = context.q;
    final link = qs(13, w: FontWeight.w600, c: q.text).copyWith(decoration: TextDecoration.underline);
    return Text.rich(
      TextSpan(style: qs(13, c: q.text2), children: [
        TextSpan(text: widget.prefix),
        TextSpan(text: 'Terms of service', style: link, recognizer: _terms, semanticsLabel: 'Terms of service, link'),
        const TextSpan(text: ' and '),
        TextSpan(text: 'Privacy policy', style: link, recognizer: _privacy, semanticsLabel: 'Privacy policy, link'),
        const TextSpan(text: '. You must be 18 or older.'),
      ]),
      textAlign: TextAlign.center,
    );
  }
}

/// Explains what deleting an account means and sends the request by email. Deletion is done by hand for
/// now (within 30 days, as the Privacy Policy says) because an owner's organisation and its other members
/// need a decision first.
class DeleteAccountScreen extends ConsumerWidget {
  const DeleteAccountScreen({super.key});

  static Uri requestUri(String? email, String? orgName) => Uri(
        scheme: 'mailto',
        path: legalContact,
        query: _query({
          'subject': 'Qline account deletion request',
          'body': 'Please delete my Qline account.\n\nAccount email: ${email ?? ''}\nOrganisation: ${orgName ?? ''}\n\n'
              'If I own an organisation that other people still use, I would like to: (transfer it to … / delete it with all its data)\n',
        }),
      );

  // Uri(queryParameters:) encodes spaces as "+", which mail apps show literally.
  static String _query(Map<String, String> m) => m.entries.map((e) => '${e.key}=${Uri.encodeComponent(e.value)}').join('&');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = context.q;
    final s = ref.watch(sessionProvider);
    Widget point(IconData i, String t) => Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(i, size: 20, color: q.text2), const SizedBox(width: 12), Expanded(child: Text(t, style: qs(15, c: q.text)))]),
        );
    return Page2(
      title: 'Delete account',
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('What happens', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        point(Icons.person_off_outlined, 'Your profile, password, sessions and connected accounts are deleted, and Qline\'s access to Google, Microsoft, Slack and the others is revoked.'),
        point(Icons.business_outlined, 'If you own an organisation that other people use, tell us whether to transfer it to another admin or delete it with all its data.'),
        point(Icons.groups_outlined, 'Work you shared in someone else\'s organisation stays with that organisation, with your name removed.'),
        point(Icons.schedule_outlined, 'We confirm the request came from you, then finish within 30 days. Backups are overwritten within about 30 days after that.'),
        point(Icons.download_outlined, 'Owners and admins can save a copy first in Settings → Export all data.'),
        const SizedBox(height: 8),
        QButton('Email deletion request', kind: QBtn.destructive, icon: Icons.mail_outline, expand: true, onPressed: () async {
          final ok = await launchUrl(requestUri(s.email, s.org?.name), mode: LaunchMode.externalApplication).catchError((_) => false);
          if (!ok && context.mounted) {
            await Clipboard.setData(const ClipboardData(text: legalContact));
            if (context.mounted) toast(context, 'No email app found. Address copied: $legalContact');
          }
        }),
        const SizedBox(height: 12),
        Text('Send it from ${s.email ?? 'the email on your account'} so we can confirm it is you. Signing out does not delete anything.', textAlign: TextAlign.center, style: qs(13, c: q.text2)),
      ]),
    );
  }
}
