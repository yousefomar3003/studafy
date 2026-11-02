import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/released_marks_providers.dart';
import '../application/student_context_providers.dart';
import '../domain/released_marks.dart';
import 'widgets/academic_result_widgets.dart';

/// A student's approved marks: each term on its own (first semester, second semester, …), then
/// the annual period for year-long assessments such as the final exam. Under each, one card per
/// subject with its categories (midterm, final exam, quizzes, …) and every assessment's mark.
///
/// A teacher's marks reach this screen only once school leadership approves that term's mark
/// sheet; the API returns nothing else. Shared by both audiences like `AcademicResultsScreen`:
/// the student opens it with no [studentId]; a parent opens it for the selected child.
class ReleasedMarksScreen extends ConsumerWidget {
  const ReleasedMarksScreen({this.studentId, this.studentName, super.key});

  /// Whose marks to show. Null = the signed-in student.
  final String? studentId;

  /// Shown under the title (a parent's child name).
  final String? studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = studentId ?? ref.watch(currentStudentIdProvider);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('releasedMarks.title'.tr()),
            if (studentName != null)
              Text(studentName!, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      body: id == null
          ? (studentId == null &&
                    ref.watch(currentStudentSelfProvider).isLoading
                ? const Center(child: CircularProgressIndicator())
                : _Message(
                    icon: Icons.info_outline,
                    message: 'releasedMarks.unavailable'.tr(),
                  ))
          : _MarksBody(studentId: id),
    );
  }
}

class _MarksBody extends ConsumerWidget {
  const _MarksBody({required this.studentId});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final marks = ref.watch(studentReleasedMarksProvider(studentId));
    final theme = Theme.of(context);

    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(studentReleasedMarksProvider(studentId));
        await ref.read(studentReleasedMarksProvider(studentId).future);
      },
      child: marks.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _Message(
          icon: Icons.error_outline,
          message: 'releasedMarks.error'.tr(),
          onRetry: () =>
              ref.invalidate(studentReleasedMarksProvider(studentId)),
        ),
        data: (periods) {
          if (periods.isEmpty) {
            return _Message(
              icon: Icons.fact_check_outlined,
              message: 'releasedMarks.empty'.tr(),
            );
          }
          final showYears =
              periods.map((p) => p.academicYearId).toSet().length > 1;
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              for (final (index, period) in periods.indexed) ...[
                if (showYears &&
                    (index == 0 ||
                        periods[index - 1].academicYearId !=
                            period.academicYearId))
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                    child: Text(
                      period.academicYearName,
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                  child: Text(
                    period.termName ?? 'releasedMarks.annual'.tr(),
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                for (final subject in period.subjects)
                  _SubjectMarksCard(subject: subject),
                const SizedBox(height: AppSpacing.space8),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _SubjectMarksCard extends StatelessWidget {
  const _SubjectMarksCard({required this.subject});

  final ReleasedMarkSubject subject;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final approvedAt = subject.approvedAt;
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(subject.name, style: theme.textTheme.titleMedium),
            if (approvedAt != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                'releasedMarks.approvedOn'.tr(
                  namedArgs: {
                    'date': DateFormat.yMMMd(
                      context.locale.toString(),
                    ).format(approvedAt.toLocal()),
                  },
                ),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            for (final category in subject.categories) ...[
              const SizedBox(height: AppSpacing.space12),
              Text(
                category.name,
                style: theme.textTheme.titleSmall?.copyWith(
                  color: theme.colorScheme.primary,
                ),
              ),
              for (final assessment in category.assessments)
                for (final attempt in assessment.attempts)
                  _MarkRow(assessment: assessment, attempt: attempt),
            ],
          ],
        ),
      ),
    );
  }
}

class _MarkRow extends StatelessWidget {
  const _MarkRow({required this.assessment, required this.attempt});

  final ReleasedAssessment assessment;
  final ReleasedMarkAttempt attempt;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final score = attempt.score;
    final value = switch (attempt.status) {
      ReleasedMarkStatus.graded when score != null =>
        '${formatResultNumber(score)} / ${formatResultNumber(assessment.maxMarks)}',
      ReleasedMarkStatus.graded => '—',
      ReleasedMarkStatus.absent => 'releasedMarks.status.absent'.tr(),
      ReleasedMarkStatus.excused => 'releasedMarks.status.excused'.tr(),
      ReleasedMarkStatus.notApplicable =>
        'releasedMarks.status.notApplicable'.tr(),
    };
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              attempt.attempt > 1
                  ? 'releasedMarks.retake'.tr(
                      namedArgs: {'name': assessment.name},
                    )
                  : assessment.name,
              style: theme.textTheme.bodyMedium,
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Text(
            value,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.message, this.onRetry});

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space32),
      children: [
        Icon(icon, size: 32, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(height: AppSpacing.space12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        if (onRetry != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Center(
            child: OutlinedButton(
              onPressed: onRetry,
              child: Text('releasedMarks.retry'.tr()),
            ),
          ),
        ],
      ],
    );
  }
}
