import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../ui/theme.dart';

/// Run 3 / M5 (docs/19): Android Back on the root screen asks before closing the app.
///
/// Only the root shell uses this. Pushed screens, sheets and dialogs handle Back themselves, so nested
/// Back keeps its normal meaning. One dialog at a time: a second Back while it is open closes the dialog
/// (= Stay), it never stacks another one.

/// Replaced in tests; closes the app the Android way (finishes the activity, like the system Back).
@visibleForTesting
Future<void> Function() exitApp = () => SystemNavigator.pop();

bool _asking = false;

/// True while the exit question is showing (exposed for tests).
bool get exitDialogOpen => _asking;

/// Asks "Close Qline?". [busy] describes work that would stop (an upload, a voice session), if any.
Future<void> confirmExit(BuildContext context, {String? busy}) async {
  if (_asking) return;
  _asking = true;
  try {
    final leave = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Close Qline?', style: qs(18, w: FontWeight.w600, c: ctx.q.text)),
        content: Text(busy ?? 'Your conversations and work are saved.', style: qs(14, c: ctx.q.text2)),
        actions: [
          TextButton(autofocus: true, onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Exit')),
        ],
      ),
    );
    if (leave == true) await exitApp();
  } finally {
    _asking = false;
  }
}
