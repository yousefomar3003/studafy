import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/child_recent_grade.dart';
import '../../../../core/api/generated/models/child_recent_grade_kind.dart';
import '../../../../design/kit/kit.dart';
import '../../../shell/application/shell_providers.dart';
import '../../../student/domain/recent_grades.dart';
import '../../../student/domain/released_marks.dart';
import '../../../student/presentation/released_marks_screen.dart';
import '../../../student/presentation/widgets/recent_grades_widgets.dart';
import '../../../student/presentation/widgets/released_marks_widgets.dart';
import '../../application/parent_providers.dart';
import 'parent_section_card.dart';

/// The parent home's "Recent grades": the newest exam marks and assignment grades across every
/// linked child ([parentRecentGradesProvider]), newest first, in the same visual language as the
/// child's own home — each row labelled "Exam" or "Assignment" with its kind's badge — and, for a
/// parent of several children, which child it is about.
///
/// An exam opens that child's full exam marks; an assignment grade switches to the Children tab
/// on that child's Grades. Says so when there is nothing yet; takes no room at all when it can't
/// load (the rest of the home is unaffected, and pull-to-refresh tries again).
class ParentRecentGradesCard extends ConsumerWidget {
  const ParentRecentGradesCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final grades = ref.watch(parentRecentGradesProvider);
    final children = ref.watch(linkedChildrenProvider).value ?? const [];

    Widget card(Widget child) => ParentSectionCard(
      key: const ValueKey('parent-recent-grades'),
      titleKey: 'grades.recent.title',
      icon: Icons.grade_outlined,
      accent: AppAccent.emerald,
      child: child,
    );

    return grades.when(
      skipLoadingOnRefresh: true,
      loading: () => card(const ParentCardSkeleton(lineCount: 2)),
      error: (_, _) => const SizedBox.shrink(),
      data: (items) {
        if (items.isEmpty) {
          return card(
            const ParentCardMessage(
              messageKey: 'grades.recent.empty',
              icon: Icons.check_circle_outline,
            ),
          );
        }
        return card(
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final item in items) _RecentGradeRow(item: item, showChild: children.length > 1),
            ],
          ),
        );
      },
    );
  }
}

class _RecentGradeRow extends ConsumerWidget {
  const _RecentGradeRow({required this.item, required this.showChild});

  final ChildRecentGrade item;
  final bool showChild;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isExam = item.kind == ChildRecentGradeKind.exam;
    final subtitle = [
      if (showChild) item.studentFirstName,
      item.subjectName,
      if (isExam && item.termName != null) item.termName!,
    ].join(' · ');

    if (!isExam) {
      return AssignmentGradeTile(
        key: ValueKey('parent-recent-grade-${item.id}'),
        label: item.name,
        subtitle: subtitle,
        score: item.score,
        maxScore: item.maxScore,
        onTap: () async {
          ref.read(childDetailGradesRequestProvider.notifier).request();
          await ref.read(selectedChildControllerProvider.notifier).select(item.studentId);
          ref.read(selectedShellTabProvider.notifier).select('shell.tabs.children');
        },
      );
    }

    final attempt = ReleasedMarkAttempt(
      attempt: item.attempt,
      status: ReleasedMarkStatus.fromWire(item.status.json),
      score: item.score?.toDouble(),
      descriptorLabel: item.descriptorLabel,
    );
    return ReleasedMarkTile(
      key: ValueKey('parent-recent-grade-${item.studentId}-${item.id}'),
      assessment: ReleasedAssessment(
        id: item.id,
        name: item.name,
        maxMarks: item.maxScore.toDouble(),
        releasedAt: item.releasedAt,
        attempts: [attempt],
      ),
      attempt: attempt,
      icon: GradeKind.exam.icon,
      accent: GradeKind.exam.accent,
      subtitle: subtitle,
      footer: const GradeKindChip(kind: GradeKind.exam),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ReleasedMarksScreen(studentId: item.studentId, studentName: item.studentName),
        ),
      ),
    );
  }
}
