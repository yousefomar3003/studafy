import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/assignment_question.dart';
import '../../../../core/api/generated/models/submission_answer.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import 'question_image.dart';

/// Read-only view of a questions assignment's answers: each question with its options, the one
/// the student chose, and — once known — which was correct.
///
/// What is "known" is decided by the API, not here. A teacher's copy of the questions carries the
/// answer key (`isCorrect` on each option); a student's does not, and their answers carry
/// `isCorrect`/`correctOptionId` only after the mark is released. Before that a student sees just
/// their own choices.
class AnswerReview extends StatelessWidget {
  const AnswerReview({
    required this.questions,
    required this.answers,
    super.key,
  });

  final List<AssignmentQuestion> questions;
  final List<SubmissionAnswer> answers;

  @override
  Widget build(BuildContext context) {
    final byQuestion = {
      for (final answer in answers) answer.questionId: answer,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final question in questions)
          _QuestionReview(question: question, answer: byQuestion[question.id]),
      ],
    );
  }
}

class _QuestionReview extends StatelessWidget {
  const _QuestionReview({required this.question, required this.answer});

  final AssignmentQuestion question;
  final SubmissionAnswer? answer;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final answer = this.answer;

    bool isCorrectOption(String optionId) =>
        answer?.correctOptionId == optionId ||
        (question.options
                .where((o) => o.id == optionId)
                .firstOrNull
                ?.isCorrect ??
            false);
    final keyKnown =
        answer?.correctOptionId != null ||
        question.options.any((o) => o.isCorrect != null);

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    questionHeading(question),
                    style: textTheme.titleSmall,
                  ),
                ),
                const SizedBox(width: AppSpacing.space8),
                Text(
                  'assignments.questions.points'.tr(
                    namedArgs: {'points': '${question.points}'},
                  ),
                  style: textTheme.bodySmall?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            QuestionImage(question: question),
            const SizedBox(height: AppSpacing.space8),
            for (final option in question.options)
              _OptionRow(
                text: option.text,
                chosen: answer?.optionId == option.id,
                correct: keyKnown && isCorrectOption(option.id),
                showKey: keyKnown,
              ),
            if (answer == null)
              Text(
                'assignments.questions.unanswered'.tr(),
                style: textTheme.bodySmall?.copyWith(color: colorScheme.error),
              ),
          ],
        ),
      ),
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.text,
    required this.chosen,
    required this.correct,
    required this.showKey,
  });

  final String text;
  final bool chosen;
  final bool correct;
  final bool showKey;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final (IconData icon, Color color, String? label) = switch ((
      chosen,
      correct,
      showKey,
    )) {
      (true, true, true) => (
        Icons.check_circle,
        colorScheme.primary,
        'assignments.questions.correct'.tr(),
      ),
      (true, false, true) => (
        Icons.cancel,
        colorScheme.error,
        'assignments.questions.incorrect'.tr(),
      ),
      (false, true, true) => (
        Icons.check_circle_outline,
        colorScheme.primary,
        'assignments.questions.rightAnswer'.tr(),
      ),
      (true, _, false) => (
        Icons.radio_button_checked,
        colorScheme.primary,
        'assignments.questions.yourAnswer'.tr(),
      ),
      _ => (Icons.radio_button_unchecked, colorScheme.onSurfaceVariant, null),
    };

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        children: [
          Icon(icon, size: 20, color: color),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              text,
              style: chosen
                  ? const TextStyle(fontWeight: FontWeight.w600)
                  : null,
            ),
          ),
          if (label != null) ...[
            const SizedBox(width: AppSpacing.space8),
            Text(
              label,
              style: Theme.of(
                context,
              ).textTheme.labelSmall?.copyWith(color: color),
            ),
          ],
        ],
      ),
    );
  }
}
