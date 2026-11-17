import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/kit.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../../shell/domain/shell_role.dart';
import '../application/work_and_grades_providers.dart';
import '../domain/work_and_grades.dart';
import 'assignments_screen.dart';
import 'grades_screen.dart';

/// The student's "Work & grades" tab: a pill toggle between its two sections —
///
/// - **Assignments** — the assignment list, due / submitted / graded ([StudentAssignmentsView]).
/// - **Grades** — approved exam marks and published assignment grades, each on its own tab
///   ([GradesView]), with the official-results entry ([AcademicResultsButton]) beside the toggle.
///
/// The selection lives in [workAndGradesProvider], so the section (and grades tab) a student last
/// picked is still showing when they come back, and the home's cards can open the tab straight
/// onto the grades ([openStudentGrades]) or the assignments ([openStudentAssignments]). Each section is built the first time it is
/// shown (the grades cost requests of their own) and then kept, so its tab and scroll position
/// survive switching back and forth.
class WorkAndGradesScreen extends ConsumerStatefulWidget {
  const WorkAndGradesScreen({super.key});

  @override
  ConsumerState<WorkAndGradesScreen> createState() => _WorkAndGradesScreenState();
}

class _WorkAndGradesScreenState extends ConsumerState<WorkAndGradesScreen> {
  final _shown = <WorkAndGradesSection>{};

  @override
  Widget build(BuildContext context) {
    final selection = ref.watch(workAndGradesProvider);
    final notifier = ref.read(workAndGradesProvider.notifier);
    _shown.add(selection.section);

    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space16,
              AppSpacing.space8,
              AppSpacing.space16,
              AppSpacing.space4,
            ),
            child: Row(
              children: [
                Expanded(
                  child: AppSegmentedToggle<WorkAndGradesSection>(
                    key: const ValueKey('work-and-grades-sections'),
                    semanticLabel: 'shell.tabs.workAndGrades'.tr(),
                    segments: [
                      AppSegment(
                        value: WorkAndGradesSection.assignments,
                        label: 'assignments.list.title'.tr(),
                        icon: Icons.assignment_outlined,
                        selectedIcon: Icons.assignment,
                      ),
                      AppSegment(
                        value: WorkAndGradesSection.grades,
                        label: 'grades.title'.tr(),
                        icon: Icons.grade_outlined,
                        selectedIcon: Icons.grade,
                      ),
                    ],
                    selected: selection.section,
                    onChanged: notifier.selectSection,
                  ),
                ),
                // The official results, certificates and report cards belong with the grades.
                AnimatedSize(
                  duration: const Duration(milliseconds: 220),
                  curve: Curves.easeOutCubic,
                  child: selection.section == WorkAndGradesSection.grades
                      ? const Padding(
                          padding: EdgeInsetsDirectional.only(start: AppSpacing.space4),
                          child: AcademicResultsButton(),
                        )
                      : const SizedBox.shrink(),
                ),
              ],
            ),
          ),
          Expanded(
            child: IndexedStack(
              index: selection.section.index,
              children: [
                if (_shown.contains(WorkAndGradesSection.assignments))
                  const StudentAssignmentsView()
                else
                  const SizedBox.shrink(),
                if (_shown.contains(WorkAndGradesSection.grades))
                  GradesView(
                    tab: selection.gradesTab,
                    onTabChanged: notifier.selectGradesTab,
                    inWorkTab: true,
                  )
                else
                  const SizedBox.shrink(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Shows the student's grades on [tab]: in the student shell, switches to the "Work & grades" tab
/// on its "Grades" section; anywhere else (no such tab to switch to), pushes [GradesScreen].
void openStudentGrades(BuildContext context, WidgetRef ref, GradesTab tab) {
  if (ref.read(shellRoleProvider) == ShellRole.student) {
    ref.read(workAndGradesProvider.notifier).showGrades(tab);
    ref.read(selectedShellTabProvider.notifier).select(workAndGradesTabKey);
    return;
  }
  Navigator.of(
    context,
  ).push(MaterialPageRoute<void>(builder: (_) => GradesScreen(initialTab: tab)));
}

/// Shows the student's assignment list: in the student shell, switches to the "Work & grades" tab
/// on its "Assignments" section; anywhere else, pushes [StudentAssignmentsScreen].
void openStudentAssignments(BuildContext context, WidgetRef ref) {
  if (ref.read(shellRoleProvider) == ShellRole.student) {
    ref.read(workAndGradesProvider.notifier).selectSection(WorkAndGradesSection.assignments);
    ref.read(selectedShellTabProvider.notifier).select(workAndGradesTabKey);
    return;
  }
  Navigator.of(
    context,
  ).push(MaterialPageRoute<void>(builder: (_) => const StudentAssignmentsScreen()));
}
