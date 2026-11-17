import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/work_and_grades.dart';

/// The shell destination key of the student's "Work & grades" tab.
const workAndGradesTabKey = 'shell.tabs.workAndGrades';

/// The "Work & grades" tab's current section and grades sub-tab.
///
/// App-scoped on purpose, like `selectedGradeTermProvider`: the section a student last picked is
/// still selected when they come back to the tab later in the session (a fresh app start opens on
/// the assignments). The home's "Recent grades" writes to it ([showGrades]) before switching to
/// the tab, so the tab opens on the grades of the kind tapped.
class WorkAndGradesNotifier extends Notifier<WorkAndGradesSelection> {
  @override
  WorkAndGradesSelection build() => const WorkAndGradesSelection();

  void selectSection(WorkAndGradesSection section) => state = state.copyWith(section: section);

  void selectGradesTab(GradesTab tab) => state = state.copyWith(gradesTab: tab);

  /// Opens the grades section on [tab].
  void showGrades(GradesTab tab) =>
      state = WorkAndGradesSelection(section: WorkAndGradesSection.grades, gradesTab: tab);
}

final workAndGradesProvider = NotifierProvider<WorkAndGradesNotifier, WorkAndGradesSelection>(
  WorkAndGradesNotifier.new,
);
