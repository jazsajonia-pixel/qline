import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qline/screens/approvals.dart';
import 'package:qline/screens/github.dart';

import 'v17_content_test.dart' show Server, app, phone, settle, loadFonts, shots, hoursAgo;

/// v1.10 (docs/24): GitHub browser and the approval diff.
/// Screenshots: `QLINE_SHOTS=1 flutter test test/v110_github_test.dart --update-goldens`
const repo = {'fullName': 'mara/shop', 'private': true, 'description': 'Storefront app', 'defaultBranch': 'main', 'language': 'TypeScript', 'archived': false, 'url': 'https://github.com/mara/shop'};

Server gh({bool contentsGranted = true}) => Server({
      'GET /github/capabilities': (_) => {
            'installed': true,
            'installations': [
              {'account': 'mara', 'permissions': {'contents': 'write'}, 'unusedRisky': ['secrets']},
            ],
            'capabilities': [
              {'id': 'code', 'name': 'Read code and history', 'permission': 'contents:read', 'granted': true},
              {'id': 'commit', 'name': 'Commit to working branches', 'permission': 'contents:write', 'granted': contentsGranted},
              {'id': 'ci', 'name': 'Read CI runs and logs', 'permission': 'actions:read', 'granted': false},
            ],
            'guarantees': ['Every change asks you first and shows the diff.', 'Never merges, force-pushes or deletes branches.'],
          },
      'GET /github/repos': (_) => {
            'installed': true,
            'repos': [
              {...repo, 'pushedAt': hoursAgo(3)},
            ],
          },
      'GET /github/repos/mara/shop/tree': (r) => r.url.queryParameters['path'] == 'src'
          ? {
              'path': 'src',
              'entries': [
                {'name': 'app.ts', 'path': 'src/app.ts', 'type': 'file', 'size': 120},
              ],
            }
          : {
              'path': '',
              'entries': [
                {'name': 'src', 'path': 'src', 'type': 'dir', 'size': 0},
                {'name': 'README.md', 'path': 'README.md', 'type': 'file', 'size': 2048},
              ],
            },
      'GET /github/repos/mara/shop/file': (_) => {'path': 'src/app.ts', 'size': 120, 'url': 'https://github.com/x', 'page': 1, 'pages': 1, 'lines': 2, 'firstLine': 1, 'text': "export const VERSION = '0.1.0';\nconst key = [redacted];", 'note': '1 secret-looking value was hidden.'},
      'GET /github/repos/mara/shop/branches': (_) => {
            'defaultBranch': 'main',
            'branches': [
              {'name': 'main', 'sha': 'aaaaaaa1111', 'protected': true, 'default': true},
              {'name': 'qline/fix-version', 'sha': 'bbbbbbb2222', 'protected': false, 'default': false},
            ],
          },
      'GET /github/repos/mara/shop/pulls': (_) => {
            'pulls': [
              {'number': 7, 'title': 'Bump version', 'state': 'open', 'draft': true, 'head': 'qline/fix-version', 'base': 'main', 'updatedAt': hoursAgo(1)},
            ],
          },
      'GET /github/repos/mara/shop/pulls/7': (_) => {
            'number': 7, 'title': 'Bump version', 'state': 'open', 'draft': true, 'head': 'qline/fix-version', 'base': 'main', 'author': 'qline-app[bot]',
            'body': 'Raises the version.', 'additions': 1, 'deletions': 1, 'changedFiles': 1,
            'files': [
              {'path': 'src/app.ts', 'status': 'modified', 'additions': 1, 'deletions': 1, 'patch': "@@ -1 +1 @@\n-export const VERSION = '0.1.0';\n+export const VERSION = '0.2.0';"},
            ],
            'reviews': [
              {'author': 'mara', 'state': 'COMMENTED', 'body': 'Looks fine'},
            ],
            'checks': {
              'overall': 'failing',
              'checkRuns': [
                {'name': 'test', 'status': 'completed', 'conclusion': 'failure'},
              ],
            },
          },
      'GET /github/repos/mara/shop/runs': (_) => {
            'total': 1,
            'runs': [
              {'id': 99, 'name': 'CI', 'title': 'Bump version', 'branch': 'qline/fix-version', 'sha': 'bbbbbbb', 'status': 'completed', 'conclusion': 'failure', 'createdAt': hoursAgo(1)},
            ],
          },
      'GET /github/repos/mara/shop/runs/99': (_) => {
            'id': 99, 'name': 'CI', 'branch': 'qline/fix-version', 'sha': 'bbbbbbb', 'status': 'completed', 'conclusion': 'failure', 'attempt': 1, 'url': 'https://github.com/x',
            'jobs': [
              {
                'name': 'test', 'status': 'completed', 'conclusion': 'failure',
                'steps': [
                  {'name': 'Run tests', 'status': 'completed', 'conclusion': 'failure'},
                ],
                'logTail': 'Error: expected 1 to be 2\nTOKEN=***',
              },
            ],
          },
      'GET /approvals/ap1': (_) => {
            'id': 'ap1', 'status': 'pending', 'risk': 'high', 'action': 'github.files.commit', 'canDecide': true, 'created_at': hoursAgo(0), 'expires_at': hoursAgo(-24),
            'preview': {
              'title': 'Commit 1 file to mara/shop on qline/fix-version',
              'lines': ['Branch qline/fix-version (new, from main)', 'Message: Bump version'],
              'diff': "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-export const VERSION = '0.1.0';\n+export const VERSION = '0.2.0';\n const x = 1;",
              'args': {'repo': 'mara/shop', 'files': [{'path': 'src/app.ts', 'content': '[33 characters, shown in the diff]'}]},
            },
          },
    });

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (c) async => null);
    await loadFonts();
  });

  for (final light in [false, true]) {
    testWidgets('GitHub home lists capabilities, unused risky permissions and repos (${light ? 'light' : 'dark'}, 390 px)', (t) async {
      phone(t, height: 1300);
      final s = gh(contentsGranted: false);
      await t.pumpWidget(app(s, const GithubScreen(), light: light));
      await settle(t);
      expect(find.text('Read code and history'), findsOneWidget);
      expect(find.textContaining('Needs the Contents (read and write) permission'), findsOneWidget);
      expect(find.textContaining('Needs the Actions (read) permission'), findsOneWidget);
      expect(find.textContaining('secrets (mara)'), findsOneWidget);
      expect(find.text('mara/shop'), findsOneWidget);
      expect(t.takeException(), isNull);
      if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/github_home_${light ? 'light' : 'dark'}.png'));
    });
  }

  testWidgets('repo browser: folders, file with redaction note, branches, PR detail with diff and checks, CI log tail', (t) async {
    phone(t);
    final s = gh();
    await t.pumpWidget(app(s, const RepoScreen(repo: repo)));
    await settle(t);
    expect(find.text('README.md'), findsOneWidget);
    await t.tap(find.text('src'));
    await settle(t);
    expect(s.hits('GET', '/github/repos/mara/shop/tree').last.url.queryParameters['path'], 'src');
    await t.tap(find.text('app.ts'));
    await settle(t);
    expect(find.textContaining('secret-looking value'), findsOneWidget);
    expect(find.textContaining('[redacted]'), findsOneWidget);
    await t.pageBack();
    await settle(t);

    await t.tap(find.text('Branches'));
    await settle(t);
    expect(find.text('Protected'), findsOneWidget);
    expect(find.text('Default'), findsOneWidget);

    await t.tap(find.text('Pull requests'));
    await settle(t);
    await t.tap(find.textContaining('#7 Bump version'));
    await settle(t);
    expect(find.text('CHECKS · FAILING'), findsOneWidget);
    expect(find.text("+export const VERSION = '0.2.0';"), findsOneWidget);
    expect(find.textContaining('Qline never merges'), findsOneWidget);
    expect(find.textContaining('mara: Commented'), findsOneWidget);
    await t.pageBack();
    await settle(t);

    await t.tap(find.text('CI'));
    await settle(t);
    await t.tap(find.textContaining('CI · Bump version'));
    await settle(t);
    expect(find.textContaining('TOKEN=***'), findsOneWidget);
    expect(find.text('Run tests'), findsOneWidget);
    expect(t.takeException(), isNull);
    // Reads only: the browser never sends a write.
    expect(s.calls.where((r) => r.method != 'GET'), isEmpty);
  });

  for (final light in [false, true]) {
    testWidgets('approval shows the GitHub diff before exact inputs (${light ? 'light' : 'dark'}, 390 px)', (t) async {
      phone(t, height: 1300);
      final s = gh();
      await t.pumpWidget(app(s, const ApprovalDetail(id: 'ap1'), light: light));
      await settle(t);
      expect(find.text('CHANGES'), findsOneWidget);
      expect(find.text("-export const VERSION = '0.1.0';"), findsOneWidget);
      expect(find.text("+export const VERSION = '0.2.0';"), findsOneWidget);
      final diffY = t.getTopLeft(find.text('CHANGES')).dy;
      final inputsY = t.getTopLeft(find.text('EXACT INPUTS')).dy;
      expect(diffY, lessThan(inputsY));
      expect(t.takeException(), isNull);
      if (shots) await expectLater(find.byType(MaterialApp), matchesGoldenFile('_shots/github_approval_${light ? 'light' : 'dark'}.png'));
    });
  }

  testWidgets('not installed shows guidance instead of an empty list', (t) async {
    phone(t);
    final s = Server({
      'GET /github/capabilities': (_) => {'installed': false, 'installations': <Object>[], 'capabilities': <Object>[], 'guarantees': <Object>[]},
      'GET /github/repos': (_) => {'installed': false, 'repos': <Object>[]},
    });
    await t.pumpWidget(app(s, const GithubScreen()));
    await settle(t);
    expect(find.text('The Qline app is not installed yet'), findsOneWidget);
  });
}
