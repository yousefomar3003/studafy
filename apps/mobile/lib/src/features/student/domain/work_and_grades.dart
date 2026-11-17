import 'package:flutter/foundation.dart';

/// The two sections of the student's "Work & grades" tab.
enum WorkAndGradesSection {
  /// The assignment list (due, submitted, graded).
  assignments,

  /// The grades view: approved exam marks and published assignment grades.
  grades,
}

/// Which tab of the grades view to show.
enum GradesTab {
  /// Exam marks school leadership has approved.
  exams,

  /// Published assignment (coursework) grades, one term at a time.
  assignments,
}

/// What the "Work & grades" tab shows: its section, and the grades view's tab within it.
@immutable
class WorkAndGradesSelection {
  const WorkAndGradesSelection({
    this.section = WorkAndGradesSection.assignments,
    this.gradesTab = GradesTab.exams,
  });

  final WorkAndGradesSection section;
  final GradesTab gradesTab;

  WorkAndGradesSelection copyWith({WorkAndGradesSection? section, GradesTab? gradesTab}) {
    return WorkAndGradesSelection(
      section: section ?? this.section,
      gradesTab: gradesTab ?? this.gradesTab,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is WorkAndGradesSelection && other.section == section && other.gradesTab == gradesTab;

  @override
  int get hashCode => Object.hash(section, gradesTab);
}
