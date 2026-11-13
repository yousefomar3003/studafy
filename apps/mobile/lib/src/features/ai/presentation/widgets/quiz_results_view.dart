import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/quiz.dart';
import '../../domain/quiz_attempt.dart';
import 'quiz_citation_chip.dart';

/// A finished round's summary: score, per-question review (your answer vs. the answer key, plus
/// its citation), and — when [QuizAttempt.wrongQuestionIds] isn't empty — the retry-wrong-only
/// action. "Results persist to progress": this is rebuilt from whatever `QuizController.restore`
/// loaded back from `QuizProgressStore` just as readily as from a round that just finished live.
class QuizResultsView extends StatelessWidget {
  const QuizResultsView({
    required this.quiz,
    required this.attempt,
    required this.onRetryWrongOnly,
    required this.onStartNewQuiz,
    super.key,
  });

  final GeneratedQuiz quiz;
  final QuizAttempt attempt;
  final VoidCallback onRetryWrongOnly;
  final VoidCallback onStartNewQuiz;

  @override
  Widget build(BuildContext context) {
    final wrongCount = attempt.wrongQuestionIds.length;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        _ScoreHeader(attempt: attempt),
        const SizedBox(height: AppSpacing.space20),
        for (final questionId in attempt.questionIds)
          _ResultRow(question: quiz.questionById(questionId), result: attempt.results[questionId]),
        const SizedBox(height: AppSpacing.space8),
        if (wrongCount > 0) ...[
          FilledButton(
            onPressed: onRetryWrongOnly,
            child: Text('quiz.results.retryWrongOnly'.tr(namedArgs: {'count': '$wrongCount'})),
          ),
          const SizedBox(height: AppSpacing.space8),
        ],
        OutlinedButton(onPressed: onStartNewQuiz, child: Text('quiz.results.newQuiz'.tr())),
      ],
    );
  }
}

class _ScoreHeader extends StatelessWidget {
  const _ScoreHeader({required this.attempt});

  final QuizAttempt attempt;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Column(
      children: [
        Text('${attempt.percentage}%', style: textTheme.displaySmall),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'quiz.results.score'.tr(
            namedArgs: {'correct': '${attempt.correctCount}', 'total': '${attempt.questionIds.length}'},
          ),
          style: TextStyle(color: colorScheme.onSurfaceVariant),
        ),
        if (attempt.round > 1) ...[
          const SizedBox(height: AppSpacing.space4),
          Text(
            'quiz.results.retryRound'.tr(namedArgs: {'round': '${attempt.round}'}),
            style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        ],
      ],
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({required this.question, required this.result});

  final QuizQuestion question;
  final QuizQuestionResult? result;

  String? _optionText(String? optionId) {
    if (optionId == null) return null;
    final options = question.options;
    if (options == null) return optionId;
    for (final option in options) {
      if (option.id == optionId) return option.text;
    }
    return optionId;
  }

  @override
  Widget build(BuildContext context) {
    final result = this.result;
    if (result == null) return const SizedBox.shrink();

    final colorScheme = Theme.of(context).colorScheme;
    final yourAnswerText = _optionText(result.yourAnswer);
    final correctAnswerText = _optionText(result.correctAnswer);

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                result.correct ? Icons.check_circle_outline : Icons.highlight_off,
                color: result.correct ? colorScheme.primary : colorScheme.error,
                size: 20,
              ),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Text(question.prompt, style: Theme.of(context).textTheme.bodyMedium),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          Padding(
            padding: const EdgeInsets.only(left: 28),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!result.correct)
                  Text(
                    yourAnswerText != null
                        ? 'quiz.results.yourAnswer'.tr(namedArgs: {'answer': yourAnswerText})
                        : 'quiz.results.notAnswered'.tr(),
                    style: TextStyle(color: colorScheme.onSurfaceVariant),
                  ),
                if (!result.correct)
                  Text(
                    'quiz.results.correctAnswer'.tr(namedArgs: {'answer': correctAnswerText ?? ''}),
                    style: TextStyle(color: colorScheme.onSurfaceVariant),
                  ),
                const SizedBox(height: AppSpacing.space4),
                QuizCitationChip(citation: question.citation),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
