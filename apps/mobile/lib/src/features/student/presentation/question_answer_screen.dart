import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/create_submission_body.dart';
import '../../../core/api/generated/models/submission_answer_input.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/assignment_detail_providers.dart';
import '../application/assignment_list_providers.dart';
import '../domain/assignment_list_filter.dart';
import 'widgets/question_image.dart';

/// Answers a questions assignment: one choice per question, all required, handed in with a single
/// `createSubmission` call. The API marks it and releases the grade at once, so the student sees
/// their score as soon as they hand in ([_showResult]), then the marked answers on the assignment.
/// Also reached for a retake the teacher allowed, pre-selecting [initialAnswers].
class QuestionAnswerScreen extends ConsumerStatefulWidget {
  const QuestionAnswerScreen({
    required this.assignment,
    this.initialAnswers = const {},
    super.key,
  });

  final Assignment assignment;

  /// Question id → chosen option id from the previous attempt.
  final Map<String, String> initialAnswers;

  @override
  ConsumerState<QuestionAnswerScreen> createState() =>
      _QuestionAnswerScreenState();
}

class _QuestionAnswerScreenState extends ConsumerState<QuestionAnswerScreen> {
  late final Map<String, String> _choices = {...widget.initialAnswers};
  bool _submitting = false;
  String? _errorKey;

  bool get _complete =>
      widget.assignment.questions.every((q) => _choices.containsKey(q.id));

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _errorKey = null;
    });
    try {
      final submission = await ref
          .read(apiClientProvider)
          .submissions
          .createSubmission(
            assignmentId: widget.assignment.id,
            body: CreateSubmissionBody(
              answers: [
                for (final question in widget.assignment.questions)
                  SubmissionAnswerInput(
                    questionId: question.id,
                    optionId: _choices[question.id]!,
                  ),
              ],
            ),
          );
      if (!mounted) return;
      ref
        ..invalidate(assignmentSubmissionProvider(widget.assignment.id))
        ..invalidate(studentAssignmentsProvider(AssignmentListFilter.due))
        ..invalidate(studentAssignmentsProvider(AssignmentListFilter.submitted))
        ..invalidate(studentAssignmentsProvider(AssignmentListFilter.graded));
      setState(() => _submitting = false);
      await _showResult(submission.score ?? submission.autoScore);
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(
        () => _errorKey = switch ((error.apiError?.status, error.type)) {
          (409, _) => 'assignments.submission.errors.closed',
          (400, _) => 'assignments.questions.errors.invalid',
          (
            _,
            DioExceptionType.connectionTimeout ||
                DioExceptionType.sendTimeout ||
                DioExceptionType.receiveTimeout ||
                DioExceptionType.connectionError,
          ) =>
            'assignments.submission.errors.network',
          _ => 'assignments.submission.errors.unknown',
        },
      );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  /// The grade, the moment it is handed in. [score] is null only if the API withheld it.
  Future<void> _showResult(num? score) {
    final max = widget.assignment.maxScore;
    return showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (context) {
        final textTheme = Theme.of(context).textTheme;
        final colorScheme = Theme.of(context).colorScheme;
        return AlertDialog(
          key: const Key('questionResultDialog'),
          icon: Icon(
            Icons.emoji_events_outlined,
            color: colorScheme.primary,
            size: 40,
          ),
          title: Text('assignments.questions.result.title'.tr()),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (score != null) ...[
                Text(
                  'assignments.questions.result.score'.tr(
                    namedArgs: {'score': _format(score), 'max': _format(max)},
                  ),
                  key: const Key('questionResultScore'),
                  style: textTheme.displaySmall?.copyWith(
                    color: colorScheme.primary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: AppSpacing.space8),
                Text(
                  'assignments.questions.result.percent'.tr(
                    namedArgs: {
                      'percent': max > 0
                          ? '${(score / max * 100).round()}'
                          : '0',
                    },
                  ),
                  style: textTheme.titleMedium,
                ),
              ] else
                Text('assignments.questions.result.pending'.tr()),
              const SizedBox(height: AppSpacing.space12),
              Text(
                'assignments.questions.result.review'.tr(),
                textAlign: TextAlign.center,
                style: textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          actions: [
            FilledButton(
              key: const Key('questionResultDone'),
              onPressed: () => Navigator.of(context).pop(),
              child: Text('assignments.questions.result.seeAnswers'.tr()),
            ),
          ],
        );
      },
    );
  }

  static String _format(num value) =>
      value == value.roundToDouble() ? '${value.toInt()}' : '$value';

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final questions = widget.assignment.questions;

    return Scaffold(
      appBar: AppBar(title: Text(widget.assignment.title)),
      body: ListView(
        padding: const EdgeInsets.all(
          AppSpacing.space16,
        ).withBottomInset(context),
        children: [
          Text(
            'assignments.questions.progress'.tr(
              namedArgs: {
                'answered': '${_choices.length}',
                'total': '${questions.length}',
              },
            ),
            style: textTheme.bodySmall?.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space12),
          for (final question in questions)
            Card(
              margin: const EdgeInsets.only(bottom: AppSpacing.space12),
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
                    RadioGroup<String>(
                      groupValue: _choices[question.id],
                      onChanged: (value) {
                        if (_submitting || value == null) return;
                        setState(() => _choices[question.id] = value);
                      },
                      child: Column(
                        children: [
                          for (final option in question.options)
                            RadioListTile<String>(
                              key: Key('answer-${question.id}-${option.id}'),
                              contentPadding: EdgeInsets.zero,
                              value: option.id,
                              title: Text(option.text),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (_errorKey case final key?) ...[
            Text(key.tr(), style: TextStyle(color: colorScheme.error)),
            const SizedBox(height: AppSpacing.space12),
          ],
          FilledButton(
            key: const Key('questionAnswersSubmit'),
            onPressed: _complete && !_submitting ? _submit : null,
            child: _submitting
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(
                    (_complete
                            ? 'assignments.submission.submit'
                            : 'assignments.questions.answerAll')
                        .tr(),
                  ),
          ),
        ],
      ),
    );
  }
}
