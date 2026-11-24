import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/mark_sheet_providers.dart';
import '../domain/mark_sheet.dart';
import 'mark_sheet_screen.dart' show MarkPreviewBadge;
import 'widgets/mark_sheet_common.dart';

/// One section's marks in a subject the signed-in teacher coordinates (000261), read-only: one
/// period at a time, its mark-sheet status, how many marks each assessment has, and every student's
/// marks with their live result. Nothing here writes — entering, submitting and releasing marks stay
/// with the section's teachers, and the API refuses them to a coordinator anyway.
///
/// Reads the same `GET .../marks` as [MarkSheetScreen] (through [markSheetProvider]); the API
/// answers a coordinator with `access: coordinator` and no write permissions.
class CoordinatorMarkSheetScreen extends ConsumerStatefulWidget {
  const CoordinatorMarkSheetScreen({
    required this.sectionId,
    required this.subjectId,
    required this.title,
    super.key,
  });

  final String sectionId;
  final String subjectId;

  /// Shown in the app bar before the sheet loads (the subject name from the overview).
  final String title;

  @override
  ConsumerState<CoordinatorMarkSheetScreen> createState() =>
      _CoordinatorMarkSheetScreenState();
}

class _CoordinatorMarkSheetScreenState
    extends ConsumerState<CoordinatorMarkSheetScreen> {
  String? _termId;
  bool _periodChosen = false;

  MarkSheetKey get _key =>
      (sectionId: widget.sectionId, subjectId: widget.subjectId);

  @override
  Widget build(BuildContext context) {
    final sheetAsync = ref.watch(markSheetProvider(_key));
    final sheet = sheetAsync.value;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(sheet?.subjectName ?? widget.title),
            if (sheet != null)
              Text(
                'teacher.marks.list.sectionLine'.tr(
                  namedArgs: {
                    'grade': sheet.gradeLevelName,
                    'section': sheet.sectionName,
                  },
                ),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
      ),
      body: sheetAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.marks.sheet.error'.tr(),
          onRetry: () => ref.invalidate(markSheetProvider(_key)),
        ),
        data: _buildSheet,
      ),
    );
  }

  Widget _buildSheet(MarkSheet sheet) {
    if (sheet.periods.isEmpty) {
      return MarksMessage(
        icon: Icons.assignment_outlined,
        message: 'teacher.marks.sheet.noPeriods'.tr(),
      );
    }
    final termId =
        _periodChosen && sheet.periods.any((p) => p.termId == _termId)
        ? _termId
        : sheet.periods.first.termId;
    final period = sheet.periodFor(termId)!;
    final assessments = [
      for (final assessment in sheet.assessmentsFor(termId))
        if (assessment.isActive) assessment,
    ];
    final theme = Theme.of(context);

    return Column(
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space16,
            AppSpacing.space8,
            AppSpacing.space16,
            AppSpacing.space4,
          ),
          child: Row(
            children: [
              for (final candidate in sheet.periods)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    end: AppSpacing.space8,
                  ),
                  child: ChoiceChip(
                    label: Text(markPeriodLabel(sheet, candidate.termId)),
                    selected: candidate.termId == termId,
                    onSelected: (_) => setState(() {
                      _termId = candidate.termId;
                      _periodChosen = true;
                    }),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => ref.invalidate(markSheetProvider(_key)),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(
                AppSpacing.space16,
              ).withBottomInset(context),
              children: [
                Card(
                  margin: EdgeInsets.zero,
                  child: ListTile(
                    leading: const Icon(Icons.visibility_outlined),
                    title: Text('teacher.coordinator.sheet.readOnly'.tr()),
                    trailing: MarkPeriodStatusPill(status: period.status),
                  ),
                ),
                const SizedBox(height: AppSpacing.space16),
                Text(
                  'teacher.marks.sheet.assessments'.tr(),
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.space8),
                if (assessments.isEmpty)
                  Text('teacher.marks.sheet.noAssessmentsInPeriod'.tr())
                else
                  for (final assessment in assessments)
                    Card(
                      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
                      child: ListTile(
                        title: Text(assessment.name),
                        subtitle: Text(
                          'teacher.coordinator.sheet.outOf'.tr(
                            namedArgs: {
                              'max': formatMarkNumber(assessment.maxMarks),
                            },
                          ),
                        ),
                        trailing: Text(
                          'teacher.marks.sheet.recorded'.tr(
                            namedArgs: {
                              'count': '${sheet.recordedCount(assessment)}',
                              'total': '${sheet.enrolledCount}',
                            },
                          ),
                        ),
                      ),
                    ),
                const SizedBox(height: AppSpacing.space16),
                Text(
                  'teacher.marks.sheet.students'.tr(),
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.space8),
                if (sheet.students.isEmpty)
                  Text('teacher.coordinator.sheet.noStudents'.tr())
                else
                  for (final student in sheet.students)
                    Card(
                      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
                      child: ListTile(
                        title: Text(student.displayName),
                        subtitle: student.isExempt || assessments.isEmpty
                            ? null
                            : Text(
                                [
                                  for (final assessment in assessments)
                                    '${assessment.name}: '
                                        '${_markText(sheet, student, assessment)}',
                                ].join('\n'),
                              ),
                        trailing: MarkPreviewBadge(student: student),
                      ),
                    ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// "45/50", the descriptor's name, or what was recorded instead of a score ("Absent"); a dash
  /// when nothing is recorded yet.
  static String _markText(
    MarkSheet sheet,
    MarkSheetStudent student,
    MarkSheetAssessment assessment,
  ) {
    final mark = student.markFor(assessment.id);
    if (mark == null) return '—';
    if (mark.status != MarkStatus.graded) {
      return 'teacher.coordinator.sheet.status.${mark.status.name}'.tr();
    }
    final descriptor = sheet.descriptorById(mark.descriptorId);
    if (descriptor != null) return descriptor.label;
    final score = mark.score;
    if (score == null) return '—';
    return '${formatMarkNumber(score)}/${formatMarkNumber(assessment.maxMarks)}';
  }
}
