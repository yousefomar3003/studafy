import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';
import 'child_attendance_card.dart';
import 'child_fees_card.dart';
import 'child_grades_card.dart';
import 'parent_section_card.dart';

/// The per-child summary block — attendance, latest grades, fees — for whichever child the
/// switcher has selected. Resolves [selectedChildProvider] once here so the three cards below
/// share a single loading / error / no-children decision; it collapses to nothing when the
/// parent has no linked children (the switcher already says so).
class ChildSummary extends ConsumerWidget {
  const ChildSummary({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(selectedChildProvider).when(
          loading: () => const _SummaryCards(
            attendance: ParentSectionCard(
              titleKey: 'parent.attendance.title',
              icon: Icons.event_available_outlined,
              child: ParentCardSkeleton(lineCount: 1),
            ),
            grades: ParentSectionCard(
              titleKey: 'parent.grades.title',
              icon: Icons.school_outlined,
              child: ParentCardSkeleton(lineCount: 2),
            ),
          ),
          error: (_, _) => const ParentSectionCard(
            titleKey: 'parent.attendance.title',
            icon: Icons.event_available_outlined,
            child: ParentCardMessage(
              messageKey: 'parent.children.error',
              icon: Icons.error_outline,
            ),
          ),
          data: (child) {
            if (child == null) return const SizedBox.shrink();
            return _SummaryCards(
              attendance: ChildAttendanceCard(child: child),
              grades: ChildGradesCard(child: child),
              fees: ChildFeesCard(studentId: child.studentId),
            );
          },
        );
  }
}

class _SummaryCards extends StatelessWidget {
  const _SummaryCards({required this.attendance, required this.grades, this.fees});

  final Widget attendance;
  final Widget grades;
  final Widget? fees;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        attendance,
        const SizedBox(height: AppSpacing.space16),
        grades,
        if (fees case final fees?) ...[
          const SizedBox(height: AppSpacing.space16),
          fees,
        ],
      ],
    );
  }
}
