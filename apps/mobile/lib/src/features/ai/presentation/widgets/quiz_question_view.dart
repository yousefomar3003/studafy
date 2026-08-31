import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/quiz.dart';
import '../../domain/quiz_attempt.dart';
import 'quiz_citation_chip.dart';

/// One round's question player: the current question, interactive until answered, then instant
/// feedback (correct/incorrect, the answer key, and a citation) once [QuizAttempt.results] has
/// an entry for it — the "instant feedback with explanation + citation" acceptance criterion.
class QuizQuestionView extends StatelessWidget {
  const QuizQuestionView({
    required this.quiz,
    required this.attempt,
    required this.isGrading,
    required this.gradeFailed,
    required this.onSubmit,
    required this.onNext,
    required this.onRetryGrade,
    required this.onEndNow,
    super.key,
  });

  final GeneratedQuiz quiz;
  final QuizAttempt attempt;
  final bool isGrading;
  final bool gradeFailed;
  final ValueChanged<String> onSubmit;
  final VoidCallback onNext;
  final VoidCallback onRetryGrade;
  final VoidCallback onEndNow;

  @override
  Widget build(BuildContext context) {
    final question = quiz.questionById(attempt.currentQuestionId);
    final result = attempt.results[question.id];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ProgressHeader(attempt: attempt, onEndNow: onEndNow),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            child: _QuestionBody(
              key: ValueKey(question.id),
              question: question,
              result: result,
              isGrading: isGrading,
              // Seeds the input from an answer already saved to `QuizProgressStore` — the resume
              // path after an app restart that landed between `submitAnswer` persisting the
              // answer and its grade response arriving, so the student doesn't have to notice
              // and re-enter it.
              savedAnswer: attempt.answers[question.id],
              onSubmit: onSubmit,
            ),
          ),
        ),
        if (gradeFailed) _GradeFailedBanner(onRetry: onRetryGrade),
        Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: FilledButton(
            onPressed: result == null ? null : onNext,
            child: Text(
              attempt.isLastQuestion ? 'quiz.player.seeResults'.tr() : 'quiz.player.next'.tr(),
            ),
          ),
        ),
      ],
    );
  }
}

class _ProgressHeader extends StatelessWidget {
  const _ProgressHeader({required this.attempt, required this.onEndNow});

  final QuizAttempt attempt;
  final VoidCallback onEndNow;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final position = attempt.currentIndex + 1;
    final total = attempt.questionIds.length;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space8,
        AppSpacing.space8,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  attempt.round > 1
                      ? 'quiz.player.progressRetry'.tr(
                          namedArgs: {'position': '$position', 'total': '$total'},
                        )
                      : 'quiz.player.progress'.tr(
                          namedArgs: {'position': '$position', 'total': '$total'},
                        ),
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              TextButton(onPressed: onEndNow, child: Text('quiz.player.endNow'.tr())),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          LinearProgressIndicator(value: position / total),
        ],
      ),
    );
  }
}

class _QuestionBody extends StatefulWidget {
  const _QuestionBody({
    required this.question,
    required this.result,
    required this.isGrading,
    required this.savedAnswer,
    required this.onSubmit,
    super.key,
  });

  final QuizQuestion question;
  final QuizQuestionResult? result;
  final bool isGrading;
  final String? savedAnswer;
  final ValueChanged<String> onSubmit;

  @override
  State<_QuestionBody> createState() => _QuestionBodyState();
}

class _QuestionBodyState extends State<_QuestionBody> {
  String? _selectedOptionId;
  late final _answerController = TextEditingController(text: widget.savedAnswer);

  @override
  void initState() {
    super.initState();
    _selectedOptionId = widget.savedAnswer;
  }

  @override
  void dispose() {
    _answerController.dispose();
    super.dispose();
  }

  bool get _canSubmit {
    if (widget.isGrading || widget.result != null) return false;
    return widget.question.type == QuizQuestionType.mcq
        ? _selectedOptionId != null
        : _answerController.text.trim().isNotEmpty;
  }

  void _submit() {
    final answer = widget.question.type == QuizQuestionType.mcq
        ? _selectedOptionId
        : _answerController.text;
    if (answer == null || answer.trim().isEmpty) return;
    widget.onSubmit(answer);
  }

  @override
  Widget build(BuildContext context) {
    final question = widget.question;
    final result = widget.result;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(question.prompt, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space16),
        if (question.type == QuizQuestionType.mcq)
          _McqInput(
            question: question,
            result: result,
            selectedOptionId: _selectedOptionId,
            enabled: result == null && !widget.isGrading,
            onSelect: (optionId) => setState(() => _selectedOptionId = optionId),
          )
        else
          _ShortAnswerInput(
            controller: _answerController,
            result: result,
            enabled: result == null && !widget.isGrading,
            onChanged: (_) => setState(() {}),
          ),
        if (result == null) ...[
          const SizedBox(height: AppSpacing.space16),
          FilledButton(
            onPressed: _canSubmit ? _submit : null,
            child: widget.isGrading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('quiz.player.checkAnswer'.tr()),
          ),
        ] else ...[
          const SizedBox(height: AppSpacing.space16),
          _FeedbackPanel(result: result, citation: question.citation),
        ],
      ],
    );
  }
}

class _McqInput extends StatelessWidget {
  const _McqInput({
    required this.question,
    required this.result,
    required this.selectedOptionId,
    required this.enabled,
    required this.onSelect,
  });

  final QuizQuestion question;
  final QuizQuestionResult? result;
  final String? selectedOptionId;
  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final options = question.options ?? const [];

    return Column(
      children: [
        for (final option in options)
          RadioListTile<String>(
            dense: true,
            contentPadding: EdgeInsets.zero,
            title: Text(option.text),
            value: option.id,
            groupValue: selectedOptionId,
            onChanged: enabled ? (value) => onSelect(value!) : null,
            secondary: result == null
                ? null
                : _optionOutcomeIcon(option.id, result!, colorScheme),
          ),
      ],
    );
  }

  Widget? _optionOutcomeIcon(String optionId, QuizQuestionResult result, ColorScheme colorScheme) {
    if (optionId == result.correctAnswer) {
      return Icon(Icons.check_circle, color: colorScheme.primary);
    }
    if (optionId == result.yourAnswer) {
      return Icon(Icons.cancel, color: colorScheme.error);
    }
    return null;
  }
}

class _ShortAnswerInput extends StatelessWidget {
  const _ShortAnswerInput({
    required this.controller,
    required this.result,
    required this.enabled,
    required this.onChanged,
  });

  final TextEditingController controller;
  final QuizQuestionResult? result;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    if (result != null) {
      return const SizedBox.shrink();
    }
    return TextField(
      controller: controller,
      enabled: enabled,
      onChanged: onChanged,
      maxLines: 3,
      minLines: 1,
      decoration: InputDecoration(
        hintText: 'quiz.player.shortAnswerHint'.tr(),
        border: const OutlineInputBorder(),
      ),
    );
  }
}

class _FeedbackPanel extends StatelessWidget {
  const _FeedbackPanel({required this.result, required this.citation});

  final QuizQuestionResult result;
  final QuizCitation citation;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final (bg, fg) = result.correct
        ? (colorScheme.primaryContainer, colorScheme.onPrimaryContainer)
        : (colorScheme.errorContainer, colorScheme.onErrorContainer);

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(result.correct ? Icons.check_circle_outline : Icons.highlight_off, color: fg),
              const SizedBox(width: AppSpacing.space8),
              Text(
                (result.correct ? 'quiz.player.correct' : 'quiz.player.incorrect').tr(),
                style: Theme.of(context).textTheme.titleSmall?.copyWith(color: fg),
              ),
            ],
          ),
          if (!result.correct) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'quiz.player.correctAnswer'.tr(namedArgs: {'answer': result.correctAnswer}),
              style: TextStyle(color: fg),
            ),
            if (result.yourAnswer != null)
              Text(
                'quiz.player.yourAnswer'.tr(namedArgs: {'answer': result.yourAnswer!}),
                style: TextStyle(color: fg),
              ),
          ],
          const SizedBox(height: AppSpacing.space8),
          QuizCitationChip(citation: citation),
        ],
      ),
    );
  }
}

class _GradeFailedBanner extends StatelessWidget {
  const _GradeFailedBanner({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
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
            Icon(Icons.wifi_off, size: 18, color: colorScheme.onErrorContainer),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                'quiz.player.gradeFailed'.tr(),
                style: TextStyle(color: colorScheme.onErrorContainer),
              ),
            ),
            TextButton(onPressed: onRetry, child: Text('quiz.player.retry'.tr())),
          ],
        ),
      ),
    );
  }
}
