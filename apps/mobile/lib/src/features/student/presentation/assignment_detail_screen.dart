import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_status.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/api/generated/models/submission_grade_status.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/assignment_detail_providers.dart';
import 'assignment_submission_screen.dart';
import 'widgets/attachment_download_tile.dart';
import 'widgets/status_pill.dart';

/// One assignment: its brief/instructions/attachments, and the caller's own submission —
/// "not submitted yet" with a submit action, or the hand-in itself plus its feedback view once
/// graded.
class AssignmentDetailScreen extends ConsumerWidget {
  const AssignmentDetailScreen({required this.assignmentId, super.key});

  final String assignmentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assignmentAsync = ref.watch(assignmentDetailProvider(assignmentId));

    return Scaffold(
      appBar: AppBar(title: Text(assignmentAsync.value?.title ?? 'assignments.detail.title'.tr())),
      body: assignmentAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stackTrace) => Center(child: Text('assignments.detail.error'.tr())),
        data: (assignment) => _AssignmentDetailBody(assignment: assignment),
      ),
    );
  }
}

class _AssignmentDetailBody extends ConsumerWidget {
  const _AssignmentDetailBody({required this.assignment});

  final Assignment assignment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final submissionAsync = ref.watch(assignmentSubmissionProvider(assignment.id));

    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(assignmentDetailProvider(assignment.id))
          ..invalidate(assignmentSubmissionProvider(assignment.id));
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          _AssignmentSummary(assignment: assignment, submission: submissionAsync.value),
          const SizedBox(height: AppSpacing.space24),
          Text(
            'assignments.detail.submissionSection'.tr(),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space12),
          submissionAsync.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.space16),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (error, stackTrace) => Text('assignments.detail.submissionError'.tr()),
            data: (submission) =>
                _SubmissionSection(assignment: assignment, submission: submission),
          ),
        ],
      ),
    );
  }
}

class _AssignmentSummary extends StatelessWidget {
  const _AssignmentSummary({required this.assignment, required this.submission});

  final Assignment assignment;
  final Submission? submission;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final dueAt = DateFormat.MMMd(context.locale.toString()).add_jm().format(assignment.dueAt);
    final isOverdueUnsubmitted = submission == null && DateTime.now().isAfter(assignment.dueAt);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.event_outlined, size: 18, color: colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                'assignments.detail.dueAt'.tr(namedArgs: {'date': dueAt}),
                style: textTheme.bodyMedium,
              ),
            ),
            if (isOverdueUnsubmitted)
              StatusPill(label: 'assignments.status.late'.tr(), tone: StatusPillTone.danger),
          ],
        ),
        const SizedBox(height: AppSpacing.space8),
        Text(
          'assignments.detail.maxScore'.tr(namedArgs: {'score': '${assignment.maxScore}'}),
          style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
        ),
        if ((assignment.description ?? '').isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space16),
          Text(assignment.description!, style: textTheme.bodyMedium),
        ],
        if ((assignment.instructions ?? '').isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(assignment.instructions!, style: textTheme.bodyMedium),
        ],
        if (assignment.attachments.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space16),
          Text('assignments.detail.attachments'.tr(), style: textTheme.titleSmall),
          for (final attachment in assignment.attachments)
            AttachmentDownloadTile(
              fileName: attachment.originalFileName,
              sizeBytes: attachment.sizeBytes,
              downloadUrl: attachment.downloadUrl,
            ),
        ],
      ],
    );
  }
}

class _SubmissionSection extends StatelessWidget {
  const _SubmissionSection({required this.assignment, required this.submission});

  final Assignment assignment;
  final Submission? submission;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    // A closed or archived assignment no longer takes hand-ins — see
    // `AssignmentsClient.deleteAssignment`'s doc comment for why an assignment with submissions
    // is archived rather than deleted. Draft never reaches a student in the first place
    // (`listAssignments` scopes drafts to teachers).
    final canAct = assignment.status == AssignmentStatus.published;
    final submission = this.submission;

    if (submission == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.info_outline, size: 18, color: colorScheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Text(
                  'assignments.detail.notSubmitted'.tr(),
                  style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space16),
          if (canAct)
            FilledButton(
              onPressed: () => _openSubmissionScreen(context),
              child: Text('assignments.detail.submit'.tr()),
            ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'assignments.detail.attempt'.tr(namedArgs: {'number': '${submission.attemptNumber}'}),
              style: textTheme.bodyMedium,
            ),
            if (submission.isLate) ...[
              const SizedBox(width: AppSpacing.space8),
              StatusPill(label: 'assignments.status.late'.tr(), tone: StatusPillTone.warning),
            ],
          ],
        ),
        if (submission.submittedAt != null) ...[
          const SizedBox(height: AppSpacing.space4),
          Text(
            'assignments.detail.submittedAt'.tr(
              namedArgs: {
                'date': DateFormat.MMMd(
                  context.locale.toString(),
                ).add_jm().format(submission.submittedAt!),
              },
            ),
            style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        ],
        if ((submission.content ?? '').isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(submission.content!, style: textTheme.bodyMedium),
        ],
        if (submission.attachments.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space12),
          for (final attachment in submission.attachments)
            AttachmentDownloadTile(
              fileName: attachment.originalFileName,
              sizeBytes: attachment.sizeBytes,
              downloadUrl: attachment.downloadUrl,
            ),
        ],
        const SizedBox(height: AppSpacing.space16),
        _FeedbackCard(submission: submission),
        if (canAct) ...[
          const SizedBox(height: AppSpacing.space16),
          OutlinedButton(
            onPressed: () => _openSubmissionScreen(context),
            child: Text('assignments.detail.resubmit'.tr()),
          ),
        ],
      ],
    );
  }

  void _openSubmissionScreen(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AssignmentSubmissionScreen(
          assignmentId: assignment.id,
          initialContent: submission?.content ?? '',
        ),
      ),
    );
  }
}

class _FeedbackCard extends StatelessWidget {
  const _FeedbackCard({required this.submission});

  final Submission submission;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    if (submission.gradeStatus != SubmissionGradeStatus.published) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Row(
            children: [
              Icon(Icons.hourglass_empty, size: 18, color: colorScheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Text(
                  'assignments.detail.awaitingGrade'.tr(),
                  style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.grade_outlined, size: 18, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text('assignments.detail.feedbackTitle'.tr(), style: textTheme.titleSmall),
                const Spacer(),
                Text(
                  '${submission.score ?? '—'}',
                  style: textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            if ((submission.feedback ?? '').isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(submission.feedback!, style: textTheme.bodyMedium),
            ],
          ],
        ),
      ),
    );
  }
}
