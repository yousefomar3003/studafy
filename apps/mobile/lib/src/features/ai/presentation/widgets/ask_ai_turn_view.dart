import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16, vertical: AppSpacing.space12),
        decoration: BoxDecoration(
          color: colorScheme.primary,
          // The tail corner points at the sender's side of the screen.
          borderRadius: const BorderRadiusDirectional.only(
            topStart: Radius.circular(20),
            topEnd: Radius.circular(20),
            bottomStart: Radius.circular(20),
            bottomEnd: Radius.circular(AppRadius.sm),
          ),
        ),
        child: Text(question, style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: colorScheme.onPrimary)),
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
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _AssistantAvatar(),
        const SizedBox(width: AppSpacing.space12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                // Centres the name on the avatar's first line.
                padding: const EdgeInsets.only(top: AppSpacing.space4, bottom: AppSpacing.space8),
                child: Text(
                  'askAi.assistantName'.tr(),
                  style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              _body(context),
            ],
          ),
        ),
      ],
    );
  }

  Widget _body(BuildContext context) {
    return switch (answer) {
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
    };
  }
}

class _AssistantAvatar extends StatelessWidget {
  const _AssistantAvatar();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      width: 28,
      height: 28,
      decoration: BoxDecoration(color: colorScheme.primaryContainer, shape: BoxShape.circle),
      child: Icon(Icons.auto_awesome, size: 16, color: colorScheme.primary),
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
            text: ' ▍',
            style: TextStyle(color: colorScheme.primary),
          ),
        ],
      ),
      style: _answerStyle(context),
    );
  }
}

/// Three dots pulsing in sequence while the assistant looks through the materials. Holds still
/// when the platform asks for reduced motion.
class _TypingIndicator extends StatefulWidget {
  const _TypingIndicator();

  @override
  State<_TypingIndicator> createState() => _TypingIndicatorState();
}

class _TypingIndicatorState extends State<_TypingIndicator> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse.stop();
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Semantics(
      label: 'askAi.thinking'.tr(),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space12, vertical: AppSpacing.space12),
        decoration: BoxDecoration(
          color: colorScheme.surface,
          borderRadius: AppRadius.lgRadius,
          border: Border.all(color: colorScheme.outlineVariant),
        ),
        child: AnimatedBuilder(
          animation: _pulse,
          builder: (context, _) => Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < 3; i++) ...[
                if (i > 0) const SizedBox(width: AppSpacing.space4),
                _dot(colorScheme.primary, i),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _dot(Color color, int index) {
    // Each dot peaks a third of a cycle after the previous one.
    final phase = (_pulse.value - index / 3) % 1.0;
    final strength = phase < 0.5 ? 1 - (phase - 0.25).abs() * 4 : 0.0;
    final t = strength.clamp(0.0, 1.0);
    return Transform.translate(
      offset: Offset(0, -3 * t),
      child: Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.35 + 0.65 * t),
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

TextStyle? _answerStyle(BuildContext context) => Theme.of(context).textTheme.bodyLarge?.copyWith(height: 1.55);

class _CompleteAnswer extends StatelessWidget {
  const _CompleteAnswer({required this.messageId, required this.text, required this.citations, required this.onReport});

  final String messageId;
  final String text;
  final List<AskAiCitation> citations;
  final ValueChanged<String> onReport;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(text, style: _answerStyle(context)),
        if (citations.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(
            'askAi.citation.heading'.tr(),
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.space4),
          Wrap(
            spacing: AppSpacing.space8,
            runSpacing: AppSpacing.space4,
            children: [for (final citation in citations) AskAiCitationChip(citation: citation)],
          ),
        ],
        const SizedBox(height: AppSpacing.space4),
        Row(
          children: [
            IconButton(
              onPressed: () => _copy(context),
              icon: const Icon(Icons.content_copy_rounded, size: 18),
              tooltip: 'askAi.copy.action'.tr(),
              visualDensity: VisualDensity.compact,
              color: colorScheme.onSurfaceVariant,
            ),
            TextButton.icon(
              onPressed: () => onReport(messageId),
              icon: const Icon(Icons.flag_outlined, size: 18),
              label: Text('askAi.report.action'.tr()),
              style: TextButton.styleFrom(
                foregroundColor: colorScheme.onSurfaceVariant,
                visualDensity: VisualDensity.compact,
              ),
            ),
          ],
        ),
      ],
    );
  }

  Future<void> _copy(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final copied = 'askAi.copy.done'.tr();
    await Clipboard.setData(ClipboardData(text: text));
    messenger.showSnackBar(SnackBar(content: Text(copied)));
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
        color: colorScheme.surface,
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
              Expanded(child: Text('askAi.refusal.title'.tr(), style: Theme.of(context).textTheme.titleSmall)),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          Text('askAi.refusal.body'.tr()),
          if (topics.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'askAi.refusal.nearest'.tr(),
              style: Theme.of(context).textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
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
                    Text(title, style: Theme.of(context).textTheme.titleSmall?.copyWith(color: fg)),
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
