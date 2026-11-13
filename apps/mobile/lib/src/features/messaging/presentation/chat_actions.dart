import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/messaging_providers.dart';
import 'widgets/report_sheet.dart';

// The block / unblock / report flows of one open chat, shared by the chat's overflow menu, its
// message long-press and the profile sheet. Each reports its outcome in a snackbar.
//
// The chat's ChatController is captured before anything is awaited, so a flow started from a
// sheet that closes meanwhile still lands on the chat.

/// Asks to confirm (what blocking does: no more messages from them, history stays), then blocks
/// [name].
Future<void> confirmAndBlock(
  BuildContext context,
  WidgetRef ref, {
  required String conversationId,
  required String name,
}) async {
  final controller = ref.read(chatControllerProvider(conversationId).notifier);
  final messenger = ScaffoldMessenger.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('messaging.block.confirmTitle'.tr(namedArgs: {'name': name})),
      content: Text('messaging.block.confirmBody'.tr(namedArgs: {'name': name})),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text('messaging.block.cancel'.tr()),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: Theme.of(context).colorScheme.error,
            foregroundColor: Theme.of(context).colorScheme.onError,
          ),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text('messaging.block.confirm'.tr()),
        ),
      ],
    ),
  );
  if (confirmed != true) return;
  try {
    await controller.block();
    _show(messenger, 'messaging.block.blockedDone'.tr(namedArgs: {'name': name}));
  } on Object {
    _show(messenger, 'messaging.block.error'.tr());
  }
}

/// Removes the caller's block on [name].
Future<void> unblockConversation(
  BuildContext context,
  WidgetRef ref, {
  required String conversationId,
  required String name,
}) async {
  final controller = ref.read(chatControllerProvider(conversationId).notifier);
  final messenger = ScaffoldMessenger.of(context);
  try {
    await controller.unblock();
    _show(messenger, 'messaging.block.unblockedDone'.tr(namedArgs: {'name': name}));
  } on Object {
    _show(messenger, 'messaging.block.error'.tr());
  }
}

/// Opens the report sheet for the conversation (or [messageId] in it) and applies the outcome:
/// "Report sent to the school" — taking the new block flags when it also blocked — or "already
/// reported". Returns whether a report was sent or already open (the sheet was not dismissed).
Future<bool> reportConversation(
  BuildContext context,
  WidgetRef ref, {
  required String conversationId,
  required String name,
  String? messageId,
  required bool canBlock,
}) async {
  final controller = ref.read(chatControllerProvider(conversationId).notifier);
  final messenger = ScaffoldMessenger.of(context);
  final result = await showReportSheet(
    context,
    conversationId: conversationId,
    name: name,
    messageId: messageId,
    canBlock: canBlock,
  );
  if (result == null) return false;
  if (result.alreadyOpen) {
    _show(messenger, 'messaging.report.alreadyOpen'.tr());
    return true;
  }
  if (result.block case final block?) controller.applyBlockState(block);
  _show(messenger, 'messaging.report.sent'.tr());
  return true;
}

void _show(ScaffoldMessengerState messenger, String message) {
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
