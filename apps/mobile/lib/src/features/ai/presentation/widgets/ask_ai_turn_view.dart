import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/ask_ai_conversation.dart';
import 'ask_ai_citation_chip.dart';

/// One question-and-answer exchange: the student's question bubble, then the assistant's reply
/// in whichever state it's currently in — streaming text, a finished answer with citation
/// chips and a report action, a grounding refusal with nearest topics, a moderation block, or
/// a mid-stream failure.
class AskAiTurnView extends StatelessWidget {
  const AskAiTurnView({required this.turn, required this.onReport, required this.onRetry, super.key});

  final AskAiTurn turn;

  /// Called with the completed answer's message id when the student taps "report".
  final ValueChanged<String> onReport;

  /// Called when the student retries a mid-stream failure.
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _QuestionBubble(question: turn.question),
        const SizedBox(height: AppSpacing.space8),
        _AnswerView(answer: turn.answer, onReport: onReport, onRetry: onRetry),
      ],
    );
  }
}

class _QuestionBubble extends StatelessWidget {
  const _QuestionBubble({required this.question});

  final String question;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space12,
          vertical: AppSpacing.space8,
        ),
        decoration: BoxDecoration(
          color: colorScheme.primaryContainer,
          borderRadius: AppRadius.lgRadius,
        ),
        child: Text(
          question,
          style: TextStyle(color: colorScheme.onPrimaryContainer),
        ),
      ),
    );
  }
}

class _AnswerView extends StatelessWidget {
  const _AnswerView({required this.answer, required this.onReport, required this.onRetry});

  final AskAiAnswer answer;
  final ValueChanged<String> onReport;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.9),
        child: switch (answer) {
          AskAiAnswerStreaming(:final text) => _StreamingAnswer(text: text),
          AskAiAnswerComplete(:final messageId, :final text, :final citations) => _CompleteAnswer(
            messageId: messageId,
            text: text,
            citations: citations,
            onReport: onReport,
          ),
          AskAiAnswerRefused(:final nearestTopics) => _RefusalCard(topics: nearestTopics),
          AskAiAnswerBlocked(:final guidance) => _NoticeCard(
            icon: Icons.shield_outlined,
            tone: _NoticeTone.warning,
            title: 'askAi.blocked.title'.tr(),
            body: guidance.isNotEmpty ? guidance : 'askAi.blocked.body'.tr(),
          ),
          AskAiAnswerFailed(:final isRetryable) => _NoticeCard(
            icon: Icons.error_outline,
            tone: _NoticeTone.error,
            title: 'askAi.failed.title'.tr(),
            body: 'askAi.failed.body'.tr(),
            onAction: isRetryable ? onRetry : null,
            actionLabel: 'askAi.failed.retry'.tr(),
          ),
        },
      ),
    );
  }
}

class _StreamingAnswer extends StatelessWidget {
  const _StreamingAnswer({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const _TypingIndicator();
    final colorScheme = Theme.of(context).colorScheme;
    // A trailing block marks the answer as still being written, token by token.
    return Text.rich(
      TextSpan(
        text: text,
        children: [
          TextSpan(
            text: ' █',
            style: TextStyle(color: colorScheme.primary),
          ),
        ],
      ),
    );
  }
}

class _TypingIndicator extends StatelessWidget {
  const _TypingIndicator();

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2, color: color),
          ),
          const SizedBox(width: AppSpacing.space8),
          Text('askAi.thinking'.tr(), style: TextStyle(color: color)),
        ],
      ),
    );
  }
}

class _CompleteAnswer extends StatelessWidget {
  const _CompleteAnswer({
    required this.messageId,
    required this.text,
    required this.citations,
    required this.onReport,
  });

  final String messageId;
  final String text;
  final List<AskAiCitation> citations;
  final ValueChanged<String> onReport;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(text),
        if (citations.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space8),
          Text(
            'askAi.citation.heading'.tr(),
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space4),
          Wrap(
            spacing: AppSpacing.space8,
            runSpacing: AppSpacing.space4,
            children: [
              for (final citation in citations) AskAiCitationChip(citation: citation),
            ],
          ),
        ],
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: () => onReport(messageId),
            icon: const Icon(Icons.flag_outlined, size: 18),
            label: Text('askAi.report.action'.tr()),
          ),
        ),
      ],
    );
  }
}

class _RefusalCard extends StatelessWidget {
  const _RefusalCard({required this.topics});

  final List<AskAiNearestTopic> topics;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.lgRadius,
        border: Border.all(color: colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.search_off, size: 18, color: colorScheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Text(
                  'askAi.refusal.title'.tr(),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          Text('askAi.refusal.body'.tr()),
          if (topics.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'askAi.refusal.nearest'.tr(),
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
            for (final topic in topics)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.space4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('•  '),
                    Expanded(child: Text(_topicLabel(topic))),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }

  String _topicLabel(AskAiNearestTopic topic) {
    final title = topic.materialTitle ?? 'askAi.citation.fallback'.tr();
    final section = topic.sectionTitle;
    return section != null && section.isNotEmpty ? '$title — $section' : title;
  }
}

enum _NoticeTone { warning, error }

class _NoticeCard extends StatelessWidget {
  const _NoticeCard({
    required this.icon,
    required this.tone,
    required this.title,
    required this.body,
    this.onAction,
    this.actionLabel,
  });

  final IconData icon;
  final _NoticeTone tone;
  final String title;
  final String body;
  final VoidCallback? onAction;
  final String? actionLabel;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final (bg, fg) = switch (tone) {
      _NoticeTone.warning => (colorScheme.tertiaryContainer, colorScheme.onTertiaryContainer),
      _NoticeTone.error => (colorScheme.errorContainer, colorScheme.onErrorContainer),
    };

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(color: bg, borderRadius: AppRadius.lgRadius),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 18, color: fg),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(color: fg),
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    Text(body, style: TextStyle(color: fg)),
                  ],
                ),
              ),
            ],
          ),
          if (onAction != null && actionLabel != null)
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(onPressed: onAction, child: Text(actionLabel!)),
            ),
        ],
      ),
    );
  }
}
