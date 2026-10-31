import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ask_ai_controller.dart';
import '../application/ask_ai_providers.dart';
import '../domain/ai_content_report.dart';
import '../domain/ask_ai_conversation.dart';
import 'widgets/ai_report_button.dart';
import 'widgets/ask_ai_composer.dart';
import 'widgets/ask_ai_turn_view.dart';
import '../../../core/features/feature_gate.dart';

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
      _controller = AskAiController(client: ref.read(askAiClientProvider), studentId: studentId)
        ..addListener(_onChange);
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

  Future<void> _reportAnswer(String messageId) => showAiReportFlow(context, ref, AiReportTarget.askAnswer(messageId));

  @override
  Widget build(BuildContext context) {
    final controller = _controller;

    return Scaffold(
      appBar: AppBar(title: Text('askAi.title'.tr())),
      body: controller == null
          ? const _SignedOutNotice()
          : Column(
              children: [
                Expanded(
                  child: _Conversation(
                    state: controller.state,
                    scrollController: _scrollController,
                    onReport: _reportAnswer,
                    onRetryTurn: controller.retryLastFailed,
                    onSuggestion: controller.send,
                  ),
                ),
                if (controller.state.sendError != null)
                  _SendErrorBanner(
                    error: controller.state.sendError!,
                    guidance: controller.state.inputBlockedGuidance,
                    canRetry: controller.retryableQuestion != null,
                    onRetry: controller.retryLastFailed,
                    onDismiss: controller.dismissSendError,
                  ),
                AskAiComposer(enabled: !controller.state.isStreaming, onSend: controller.send),
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
    required this.onSuggestion,
  });

  final AskAiConversation state;
  final ScrollController scrollController;
  final ValueChanged<String> onReport;
  final VoidCallback onRetryTurn;
  final ValueChanged<String> onSuggestion;

  @override
  Widget build(BuildContext context) {
    if (state.isEmpty) return _EmptyState(onSuggestion: onSuggestion);

    return ListView.separated(
      controller: scrollController,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space24,
      ),
      itemCount: state.turns.length,
      separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.space24),
      itemBuilder: (context, index) =>
          AskAiTurnView(turn: state.turns[index], onReport: onReport, onRetry: onRetryTurn),
    );
  }
}

/// Starter prompts on the empty screen; tapping one sends it as the first question.
const _suggestionKeys = [
  'askAi.empty.suggestions.summarize',
  'askAi.empty.suggestions.explain',
  'askAi.empty.suggestions.review',
];

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onSuggestion});

  final ValueChanged<String> onSuggestion;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return LayoutBuilder(
      // Scrolls rather than overflows when the keyboard is up on a short screen.
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space24, vertical: AppSpacing.space32),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight - AppSpacing.space64),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [colorScheme.primaryContainer, colorScheme.surface],
                      ),
                      border: Border.all(color: colorScheme.primaryContainer),
                    ),
                    child: Icon(Icons.auto_awesome, size: 30, color: colorScheme.primary),
                  ),
                  const SizedBox(height: AppSpacing.space20),
                  Text('askAi.empty.title'.tr(), style: theme.textTheme.titleLarge, textAlign: TextAlign.center),
                  const SizedBox(height: AppSpacing.space8),
                  Text(
                    'askAi.empty.hint'.tr(),
                    style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.space32),
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: Text(
                      'askAi.empty.suggestionsHeading'.tr(),
                      style: theme.textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  for (final key in _suggestionKeys) ...[
                    _SuggestionTile(label: key.tr(), onTap: () => onSuggestion(key.tr())),
                    const SizedBox(height: AppSpacing.space8),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return Material(
      color: colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.lgRadius,
        side: BorderSide(color: colorScheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16, vertical: AppSpacing.space12),
          child: Row(
            children: [
              Expanded(child: Text(label, style: theme.textTheme.bodyMedium)),
              const SizedBox(width: AppSpacing.space8),
              Icon(Icons.arrow_forward_rounded, size: 18, color: colorScheme.primary),
            ],
          ),
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
        : error == AskAiSendError.featureLimitReached
        ? featureLimitReachedMessage(context)
        : _messageKeyFor(error).tr();

    return Material(
      color: colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.space16, AppSpacing.space8, AppSpacing.space8, AppSpacing.space8),
        child: Row(
          children: [
            Icon(Icons.info_outline, size: 18, color: colorScheme.onErrorContainer),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(message, style: TextStyle(color: colorScheme.onErrorContainer)),
            ),
            if (canRetry) TextButton(onPressed: onRetry, child: Text('askAi.sendError.retry'.tr())),
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
    AskAiSendError.featureLimitReached => 'features.errors.limitReached',
    AskAiSendError.schoolInactive => 'askAi.sendError.schoolInactive',
    AskAiSendError.llmDisabled => 'askAi.sendError.llmDisabled',
    AskAiSendError.temporarilyUnavailable => 'askAi.sendError.temporarilyUnavailable',
    AskAiSendError.questionBlocked => 'askAi.sendError.questionBlocked',
    AskAiSendError.notAllowed => 'askAi.sendError.notAllowed',
    AskAiSendError.network => 'askAi.sendError.network',
    AskAiSendError.unknown => 'askAi.sendError.unknown',
  };
}
