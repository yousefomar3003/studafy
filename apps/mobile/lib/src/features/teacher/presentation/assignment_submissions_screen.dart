import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/api/generated/models/submission_grade_status.dart';
import '../../../core/api/generated/models/submission_status.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/status_pill.dart';
import '../application/submission_review_providers.dart';
import '../application/teacher_providers.dart';
import 'submission_marking_screen.dart';

/// Where one student stands on an assignment, for the submissions list.
enum SubmissionReviewStatus { notHandedIn, toMark, draft, published, returned }

SubmissionReviewStatus reviewStatusOf(Submission? submission) {
  if (submission == null) return SubmissionReviewStatus.notHandedIn;
  if (submission.status == SubmissionStatus.returned) {
    return SubmissionReviewStatus.returned;
  }
  return switch (submission.gradeStatus) {
    SubmissionGradeStatus.published => SubmissionReviewStatus.published,
    SubmissionGradeStatus.draft => SubmissionReviewStatus.draft,
    _ => SubmissionReviewStatus.toMark,
  };
}

/// One assignment's hand-ins across the whole class roster: who hasn't handed in, what still
/// needs a mark, draft marks, and what is published or returned, with late work flagged. Tapping
/// a hand-in opens [SubmissionMarkingScreen]; "Publish ready marks" releases every draft mark at
/// once, after confirming.
class AssignmentSubmissionsScreen extends ConsumerStatefulWidget {
  const AssignmentSubmissionsScreen({required this.assignment, super.key});

  final Assignment assignment;

  @override
  ConsumerState<AssignmentSubmissionsScreen> createState() =>
      _AssignmentSubmissionsScreenState();
}

class _AssignmentSubmissionsScreenState
    extends ConsumerState<AssignmentSubmissionsScreen> {
  bool _publishing = false;

  Future<void> _publishReady(List<Submission> ready) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('teacher.submissions.publishAll.title'.tr()),
        content: Text(
          'teacher.submissions.publishAll.body'.tr(
            namedArgs: {'count': '${ready.length}'},
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('teacher.submissions.publishAll.cancel'.tr()),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('teacher.submissions.publishAll.confirm'.tr()),
          ),
        ],
      ),
    );
    if (!(confirmed ?? false) || !mounted) return;

    setState(() => _publishing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final count = await ref.read(publishReadyMarksProvider)(ready);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            'teacher.submissions.publishAll.done'.tr(
              namedArgs: {'count': '$count'},
            ),
          ),
        ),
      );
    } on Object {
      messenger.showSnackBar(
        SnackBar(content: Text('teacher.submissions.publishAll.failed'.tr())),
      );
    } finally {
      if (mounted) setState(() => _publishing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final assignment = widget.assignment;
    final submissions = ref.watch(assignmentSubmissionsProvider(assignment.id));
    final roster = ref.watch(classRosterProvider(assignment.classId));
    // Fills the name cache the rows read; failures just leave short ids.
    ref.watch(classRosterNamesProvider(assignment.classId));

    return Scaffold(
      appBar: AppBar(title: Text(assignment.title)),
      body: RefreshIndicator(
        onRefresh: () async {
          ref
            ..invalidate(assignmentSubmissionsProvider(assignment.id))
            ..invalidate(classRosterProvider(assignment.classId));
        },
        child: switch ((submissions, roster)) {
          (
            AsyncData(value: final byStudent),
            AsyncData(value: final enrollments),
          ) =>
            () {
              // Roster order, then anyone who handed in but has since left the class.
              final studentIds = [
                for (final enrollment in enrollments) enrollment.studentId,
                for (final studentId in byStudent.keys)
                  if (!enrollments.any((e) => e.studentId == studentId))
                    studentId,
              ];
              final ready = byStudent.values.where(isReadyToPublish).toList();
              final handedIn = byStudent.length;
              return ListView(
                padding: const EdgeInsets.all(
                  AppSpacing.space16,
                ).withBottomInset(context),
                children: [
                  Text(
                    'teacher.submissions.summary'.tr(
                      namedArgs: {
                        'handedIn': '$handedIn',
                        'total': '${studentIds.length}',
                      },
                    ),
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  if (ready.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.space12),
                    FilledButton.icon(
                      key: const Key('publishReadyMarks'),
                      onPressed: _publishing
                          ? null
                          : () => _publishReady(ready),
                      icon: _publishing
                          ? const SizedBox.square(
                              dimension: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.publish_outlined),
                      label: Text(
                        'teacher.submissions.publishAll.action'.tr(
                          namedArgs: {'count': '${ready.length}'},
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.space16),
                  if (studentIds.isEmpty)
                    Text('teacher.submissions.emptyRoster'.tr())
                  else
                    Card(
                      margin: EdgeInsets.zero,
                      clipBehavior: Clip.antiAlias,
                      child: Column(
                        children: [
                          for (final (index, studentId)
                              in studentIds.indexed) ...[
                            if (index > 0) const Divider(height: 1),
                            _StudentRow(
                              assignment: assignment,
                              studentId: studentId,
                              submission: byStudent[studentId],
                            ),
                          ],
                        ],
                      ),
                    ),
                ],
              );
            }(),
          (AsyncError(), _) || (_, AsyncError()) => ListView(
            padding: const EdgeInsets.all(AppSpacing.space24),
            children: [
              Text(
                'teacher.submissions.loadError'.tr(),
                textAlign: TextAlign.center,
              ),
            ],
          ),
          _ => const Center(child: CircularProgressIndicator()),
        },
      ),
    );
  }
}

class _StudentRow extends ConsumerWidget {
  const _StudentRow({
    required this.assignment,
    required this.studentId,
    required this.submission,
  });

  final Assignment assignment;
  final String studentId;
  final Submission? submission;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name =
        ref.watch(rosterStudentNameProvider(studentId)) ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {'id': shortStudentId(studentId)},
        );
    final submission = this.submission;
    final status = reviewStatusOf(submission);
    final (label, tone) = switch (status) {
      SubmissionReviewStatus.notHandedIn => (
        'notHandedIn',
        StatusPillTone.neutral,
      ),
      SubmissionReviewStatus.toMark => ('toMark', StatusPillTone.warning),
      SubmissionReviewStatus.draft => ('draft', StatusPillTone.neutral),
      SubmissionReviewStatus.published => ('published', StatusPillTone.success),
      SubmissionReviewStatus.returned => ('returned', StatusPillTone.neutral),
    };

    return ListTile(
      title: Text(name),
      subtitle: submission == null
          ? null
          : Text(
              [
                'teacher.submissions.attempt'.tr(
                  namedArgs: {'number': '${submission.attemptNumber}'},
                ),
                if (submission.score case final score?)
                  'teacher.submissions.score'.tr(
                    namedArgs: {
                      'score': '$score',
                      'max': '${assignment.maxScore}',
                    },
                  ),
              ].join(' · '),
            ),
      trailing: Wrap(
        spacing: AppSpacing.space4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (submission?.isLate ?? false)
            StatusPill(
              label: 'assignments.status.late'.tr(),
              tone: StatusPillTone.danger,
            ),
          StatusPill(
            label: 'teacher.submissions.status.$label'.tr(),
            tone: tone,
          ),
        ],
      ),
      onTap: submission == null
          ? null
          : () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SubmissionMarkingScreen(
                  assignment: assignment,
                  submissionId: submission.id,
                  studentName: name,
                ),
              ),
            ),
    );
  }
}

/// The last six characters of a student id, for a row whose name hasn't loaded.
String shortStudentId(String studentId) => studentId.length <= 6
    ? studentId
    : studentId.substring(studentId.length - 6);
