import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/work_and_grades.dart';

/// The shell destination key of the student's "Work & grades" tab.
const workAndGradesTabKey = 'shell.tabs.workAndGrades';

/// The "Work & grades" tab's current section and grades sub-tab.
///
/// App-scoped on purpose, like `selectedGradeTermProvider`: the section a student last picked is
/// still selected when they come back to the tab later in the session (a fresh app start opens on
/// the assignments). The home's "Recent grades" and "Due soon" and the notification inbox write to
/// it ([showGrades], [open]) before switching to the tab, so it opens on what was tapped.
class WorkAndGradesNotifier extends Notifier<WorkAndGradesSelection> {
  @override
  WorkAndGradesSelection build() => const WorkAndGradesSelection();

  void selectSection(WorkAndGradesSection section) => state = state.copyWith(section: section);

  void selectGradesTab(GradesTab tab) => state = state.copyWith(gradesTab: tab);

  /// Opens [section], and with [gradesTab] the grades on that tab; the other choice is kept.
  void open(WorkAndGradesSection section, {GradesTab? gradesTab}) =>
      state = state.copyWith(section: section, gradesTab: gradesTab);

  /// Opens the grades section on [tab].
  void showGrades(GradesTab tab) =>
      state = WorkAndGradesSelection(section: WorkAndGradesSection.grades, gradesTab: tab);
}

final workAndGradesProvider = NotifierProvider<WorkAndGradesNotifier, WorkAndGradesSelection>(
  WorkAndGradesNotifier.new,
);
