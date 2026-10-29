import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_kind.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/api/generated/models/submission_grade_status.dart';
import '../../../core/api/generated/models/submission_status.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/answer_review.dart';
import '../../student/presentation/widgets/attachment_download_tile.dart';
import '../application/submission_review_providers.dart';

/// What the teacher asked the marking screen to do with the mark.
enum MarkingAction { saveDraft, publish, returnToStudent }

/// Marks one hand-in: the student's answer and files, a score out of the assignment's maximum and
/// feedback. The mark can be saved as a staff-only draft, published to the student and their
/// parents (after confirming), or the work can be returned for another attempt. A published mark
/// is changed through the gradebook's correction flow, not here, so it shows read-only.
class SubmissionMarkingScreen extends ConsumerStatefulWidget {
  const SubmissionMarkingScreen({
    required this.assignment,
    required this.submissionId,
    required this.studentName,
    super.key,
  });

  final Assignment assignment;
  final String submissionId;
  final String studentName;

  @override
  ConsumerState<SubmissionMarkingScreen> createState() =>
      _SubmissionMarkingScreenState();
}

class _SubmissionMarkingScreenState
    extends ConsumerState<SubmissionMarkingScreen> {
  final _scoreController = TextEditingController();
  final _feedbackController = TextEditingController();
  String? _loadedId;
  MarkingAction? _busy;
  String? _errorKey;

  @override
  void dispose() {
    _scoreController.dispose();
    _feedbackController.dispose();
    super.dispose();
  }

  /// Seeds the fields from [submission] once, so a reload doesn't overwrite what's being typed.
  void _seed(Submission submission) {
    if (_loadedId == submission.id) return;
    _loadedId = submission.id;
    // A questions assignment is marked automatically; its score starts from that mark.
    final score = submission.score ?? submission.autoScore;
    _scoreController.text = score == null ? '' : '$score';
    _feedbackController.text = submission.feedback ?? '';
  }

  /// The typed score, or null when blank. Throws [FormatException] for anything unparsable or out
  /// of range, which [_submit] reports.
  num? _score() {
    final text = _scoreController.text.trim();
    if (text.isEmpty) return null;
    final score = num.parse(text.replaceAll(',', '.'));
    if (score < 0 || score > widget.assignment.maxScore) {
      throw const FormatException();
    }
    return score;
  }

  Future<void> _submit(Submission submission, MarkingAction action) async {
    final num? score;
    try {
      score = _score();
    } on FormatException {
      setState(() => _errorKey = 'teacher.marking.errors.score');
      return;
    }
    if (action == MarkingAction.publish && score == null) {
      setState(() => _errorKey = 'teacher.marking.errors.scoreRequired');
      return;
    }
    if (action != MarkingAction.saveDraft) {
      final confirmed = await _confirm(action);
      if (!confirmed || !mounted) return;
    }

    final feedback = _feedbackController.text.trim();
    setState(() {
      _busy = action;
      _errorKey = null;
    });
    try {
      await ref.read(gradeSubmissionProvider)(
        submission: submission,
        body: SparseGradeSubmissionBody(
          score: action == MarkingAction.returnToStudent ? null : score,
          feedback: feedback.isEmpty ? null : feedback,
          publish: action == MarkingAction.publish,
          returnToStudent: action == MarkingAction.returnToStudent,
        ),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('teacher.marking.done.${action.name}'.tr())),
      );
      if (action == MarkingAction.saveDraft) {
        setState(() => _busy = null);
      } else {
        Navigator.of(context).pop();
      }
    } catch (error) {
      if (!mounted) return;
      final code = error is DioException ? error.apiError?.code : null;
      setState(() {
        _busy = null;
        _errorKey = code == 'SUBMISSION_SCORE_EXCEEDS_MAX'
            ? 'teacher.marking.errors.score'
            : 'teacher.marking.errors.failed';
      });
    }
  }

  Future<bool> _confirm(MarkingAction action) async {
    final key = 'teacher.marking.confirm.${action.name}';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('$key.title'.tr()),
        content: Text('$key.body'.tr(namedArgs: {'name': widget.studentName})),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('teacher.marking.confirm.cancel'.tr()),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('$key.action'.tr()),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final loaded = ref.watch(submissionDetailProvider(widget.submissionId));

    return Scaffold(
      appBar: AppBar(title: Text(widget.studentName)),
      body: loaded.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'teacher.marking.loadError'.tr(),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.space12),
                OutlinedButton(
                  onPressed: () => ref.invalidate(
                    submissionDetailProvider(widget.submissionId),
                  ),
                  child: Text('account.retry'.tr()),
                ),
              ],
            ),
          ),
        ),
        data: (submission) {
          _seed(submission);
          return _body(context, submission);
        },
      ),
    );
  }

  Widget _body(BuildContext context, Submission submission) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final published =
        submission.gradeStatus == SubmissionGradeStatus.published &&
        submission.status != SubmissionStatus.returned;
    final busy = _busy != null;
    final submittedAt = submission.submittedAt;

    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Text(widget.assignment.title, style: textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space4),
        Text(
          [
            'teacher.submissions.attempt'.tr(
              namedArgs: {'number': '${submission.attemptNumber}'},
            ),
            if (submittedAt != null)
              DateFormat.MMMd(
                context.locale.toString(),
              ).add_jm().format(submittedAt.toLocal()),
            if (submission.isLate) 'assignments.status.late'.tr(),
          ].join(' · '),
          style: textTheme.bodySmall?.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space16),
        if (widget.assignment.kind == AssignmentKind.questions) ...[
          Text(
            'teacher.marking.autoScore'.tr(
              namedArgs: {
                'score': '${submission.autoScore ?? 0}',
                'max': '${widget.assignment.maxScore}',
              },
            ),
            style: textTheme.titleSmall,
          ),
          const SizedBox(height: AppSpacing.space8),
          AnswerReview(
            questions: widget.assignment.questions,
            answers: submission.answers,
          ),
        ] else ...[
          Text('teacher.marking.answer'.tr(), style: textTheme.titleSmall),
          const SizedBox(height: AppSpacing.space8),
          Text(
            (submission.content ?? '').isEmpty
                ? 'teacher.marking.noText'.tr()
                : submission.content!,
            style: textTheme.bodyMedium,
          ),
        ],
        for (final attachment in submission.attachments)
          AttachmentDownloadTile(
            fileName: attachment.originalFileName,
            sizeBytes: attachment.sizeBytes,
            downloadUrl: attachment.downloadUrl,
          ),
        const Divider(height: AppSpacing.space32),
        TextField(
          key: const Key('markingScore'),
          controller: _scoreController,
          enabled: !busy && !published,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]')),
          ],
          decoration: InputDecoration(
            labelText: 'teacher.marking.scoreLabel'.tr(),
            suffixText: '/ ${widget.assignment.maxScore}',
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: AppSpacing.space12),
        TextField(
          key: const Key('markingFeedback'),
          controller: _feedbackController,
          enabled: !busy && !published,
          maxLines: 5,
          decoration: InputDecoration(
            labelText: 'teacher.marking.feedbackLabel'.tr(),
            border: const OutlineInputBorder(),
          ),
        ),
        if (_errorKey case final key?) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(
            key.tr(namedArgs: {'max': '${widget.assignment.maxScore}'}),
            style: TextStyle(color: colorScheme.error),
          ),
        ],
        const SizedBox(height: AppSpacing.space16),
        if (published)
          Text(
            'teacher.marking.publishedNote'.tr(),
            style: textTheme.bodySmall?.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          )
        else ...[
          FilledButton(
            key: const Key('markingPublish'),
            onPressed: busy
                ? null
                : () => _submit(submission, MarkingAction.publish),
            child: _label(MarkingAction.publish),
          ),
          const SizedBox(height: AppSpacing.space8),
          OutlinedButton(
            key: const Key('markingSaveDraft'),
            onPressed: busy
                ? null
                : () => _submit(submission, MarkingAction.saveDraft),
            child: _label(MarkingAction.saveDraft),
          ),
          TextButton(
            key: const Key('markingReturn'),
            onPressed: busy
                ? null
                : () => _submit(submission, MarkingAction.returnToStudent),
            child: _label(MarkingAction.returnToStudent),
          ),
        ],
      ],
    );
  }

  Widget _label(MarkingAction action) => _busy == action
      ? const SizedBox.square(
          dimension: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        )
      : Text('teacher.marking.actions.${action.name}'.tr());
}
