import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ask_ai_controller.dart';
import '../application/ask_ai_providers.dart';
import '../data/ask_ai_client.dart';
import '../domain/ask_ai_conversation.dart';
import 'widgets/ask_ai_composer.dart';
import 'widgets/ask_ai_turn_view.dart';

/// Ask AI: a streaming chat grounded in the school's study materials. The student asks a
/// question, the answer streams in token by token with tappable citation chips, and grounding
/// refusals / quota limits / moderation blocks each render as their own distinct state.
///
/// Route-only (`/me/ask-ai`), like the other self-scoped student screens. Needs the signed-in
/// student's id (their user id — see [askAiStudentIdProvider]); with no session it shows the
/// signed-out state instead of a dead input.
class AskAiScreen extends ConsumerStatefulWidget {
  const AskAiScreen({super.key});

  @override
  ConsumerState<AskAiScreen> createState() => _AskAiScreenState();
}

class _AskAiScreenState extends ConsumerState<AskAiScreen> {
  AskAiController? _controller;
  final _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId != null) {
      _controller = AskAiController(
        client: ref.read(askAiClientProvider),
        studentId: studentId,
      )..addListener(_onChange);
    }
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  void dispose() {
    _controller?.removeListener(_onChange);
    _controller?.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _reportAnswer(String messageId) async {
    final controller = _controller;
    if (controller == null) return;

    final reason = await showDialog<String>(
      context: context,
      builder: (context) => const _ReportDialog(),
    );
    if (reason == null || reason.trim().isEmpty || !mounted) return;

    final outcome = await controller.reportAnswer(messageId: messageId, reason: reason.trim());
    if (!mounted) return;

    final messageKey = switch (outcome) {
      AskAiReportOutcome.filed => 'askAi.report.filed',
      AskAiReportOutcome.alreadyFiled => 'askAi.report.alreadyFiled',
      AskAiReportOutcome.failed => 'askAi.report.failed',
    };
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(messageKey.tr())));
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;

    return Scaffold(
      appBar: AppBar(title: Text('askAi.title'.tr())),
      body: controller == null
          ? const _SignedOutNotice()
          : Column(
              children: [
                Expanded(child: _Conversation(state: controller.state, scrollController: _scrollController, onReport: _reportAnswer, onRetryTurn: controller.retryLastFailed)),
                if (controller.state.sendError != null)
                  _SendErrorBanner(
                    error: controller.state.sendError!,
                    guidance: controller.state.inputBlockedGuidance,
                    canRetry: controller.retryableQuestion != null,
                    onRetry: controller.retryLastFailed,
                    onDismiss: controller.dismissSendError,
                  ),
                AskAiComposer(
                  enabled: !controller.state.isStreaming,
                  onSend: controller.send,
                ),
              ],
            ),
    );
  }
}

class _Conversation extends StatelessWidget {
  const _Conversation({
    required this.state,
    required this.scrollController,
    required this.onReport,
    required this.onRetryTurn,
  });

  final AskAiConversation state;
  final ScrollController scrollController;
  final ValueChanged<String> onReport;
  final VoidCallback onRetryTurn;

  @override
  Widget build(BuildContext context) {
    if (state.isEmpty) return const _EmptyState();

    return ListView.separated(
      controller: scrollController,
      padding: const EdgeInsets.all(AppSpacing.space16),
      itemCount: state.turns.length,
      separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.space24),
      itemBuilder: (context, index) => AskAiTurnView(
        turn: state.turns[index],
        onReport: onReport,
        onRetry: onRetryTurn,
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.auto_awesome_outlined, size: 36, color: colorScheme.primary),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'askAi.empty.title'.tr(),
              style: Theme.of(context).textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'askAi.empty.hint'.tr(),
              style: TextStyle(color: colorScheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _SignedOutNotice extends StatelessWidget {
  const _SignedOutNotice();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'askAi.signedOut'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

/// The pre-stream failure banner: quota spent, add-on inactive, AI switched off, question
/// blocked, etc. — each with its own line, and a retry only for the transient ones.
class _SendErrorBanner extends StatelessWidget {
  const _SendErrorBanner({
    required this.error,
    required this.guidance,
    required this.canRetry,
    required this.onRetry,
    required this.onDismiss,
  });

  final AskAiSendError error;
  final String? guidance;
  final bool canRetry;
  final VoidCallback onRetry;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final message = error == AskAiSendError.questionBlocked && (guidance?.isNotEmpty ?? false)
        ? guidance!
        : _messageKeyFor(error).tr();

    return Material(
      color: colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space16,
          AppSpacing.space8,
          AppSpacing.space8,
          AppSpacing.space8,
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, size: 18, color: colorScheme.onErrorContainer),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                message,
                style: TextStyle(color: colorScheme.onErrorContainer),
              ),
            ),
            if (canRetry)
              TextButton(onPressed: onRetry, child: Text('askAi.sendError.retry'.tr())),
            IconButton(
              onPressed: onDismiss,
              icon: const Icon(Icons.close, size: 18),
              tooltip: 'askAi.sendError.dismiss'.tr(),
            ),
          ],
        ),
      ),
    );
  }

  String _messageKeyFor(AskAiSendError error) => switch (error) {
    AskAiSendError.quotaExceeded => 'askAi.sendError.quotaExceeded',
    AskAiSendError.subscriptionInactive => 'askAi.sendError.subscriptionInactive',
    AskAiSendError.schoolInactive => 'askAi.sendError.schoolInactive',
    AskAiSendError.llmDisabled => 'askAi.sendError.llmDisabled',
    AskAiSendError.temporarilyUnavailable => 'askAi.sendError.temporarilyUnavailable',
    AskAiSendError.questionBlocked => 'askAi.sendError.questionBlocked',
    AskAiSendError.notAllowed => 'askAi.sendError.notAllowed',
    AskAiSendError.network => 'askAi.sendError.network',
    AskAiSendError.unknown => 'askAi.sendError.unknown',
  };
}

class _ReportDialog extends StatefulWidget {
  const _ReportDialog();

  @override
  State<_ReportDialog> createState() => _ReportDialogState();
}

class _ReportDialogState extends State<_ReportDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('askAi.report.dialogTitle'.tr()),
      content: TextField(
        controller: _controller,
        autofocus: true,
        minLines: 2,
        maxLines: 4,
        maxLength: 1000,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          hintText: 'askAi.report.dialogHint'.tr(),
          border: const OutlineInputBorder(),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('askAi.report.cancel'.tr()),
        ),
        FilledButton(
          onPressed: _controller.text.trim().isEmpty
              ? null
              : () => Navigator.of(context).pop(_controller.text),
          child: Text('askAi.report.submit'.tr()),
        ),
      ],
    );
  }
}
