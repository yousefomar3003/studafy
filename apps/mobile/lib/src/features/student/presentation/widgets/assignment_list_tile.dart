import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/submission_grade_status.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/assignment_submission_pair.dart';
import 'status_pill.dart';

/// One row on the assignment list screen: title, due date, and a trailing [StatusPill] summarizing
/// where the caller's own submission (if any) stands.
class AssignmentListTile extends StatelessWidget {
  const AssignmentListTile({required this.pair, required this.onTap, super.key});

  final AssignmentSubmissionPair pair;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final assignment = pair.assignment;
    final dueAt = DateFormat.MMMd(context.locale.toString()).add_jm().format(assignment.dueAt);

    return ListTile(
      onTap: onTap,
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
      title: Text(assignment.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        'assignments.list.dueAt'.tr(namedArgs: {'date': dueAt}),
        style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
      ),
      trailing: _buildPill(context),
    );
  }

  Widget? _buildPill(BuildContext context) {
    final submission = pair.submission;

    if (submission?.gradeStatus == SubmissionGradeStatus.published) {
      final score = submission!.score;
      return StatusPill(
        label: score == null
            ? 'assignments.status.graded'.tr()
            : '$score/${pair.assignment.maxScore}',
        tone: StatusPillTone.success,
      );
    }
    if (submission != null) {
      return StatusPill(
        label: submission.isLate
            ? 'assignments.status.late'.tr()
            : 'assignments.status.submitted'.tr(),
        tone: submission.isLate ? StatusPillTone.warning : StatusPillTone.neutral,
      );
    }
    if (DateTime.now().isAfter(pair.assignment.dueAt)) {
      return StatusPill(label: 'assignments.status.late'.tr(), tone: StatusPillTone.danger);
    }
    return null;
  }
}
