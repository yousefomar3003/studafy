import '../../../core/api/generated/models/published_grade.dart';
import 'released_marks.dart';

/// The two kinds of mark a student gets, which every grades view keeps visibly apart:
///
/// - [exam] — an exam mark school leadership approved and released to the family
///   (`GET /api/grading/students/{id}/marks`, see `released_marks.dart`);
/// - [assignment] — a published coursework grade from the class gradebook (assignments and
///   submissions, the published-grades snapshot).
enum GradeKind { exam, assignment }

/// One row of a "Recent grades" list: an approved exam mark or a published assignment grade.
sealed class RecentGrade {
  const RecentGrade();

  GradeKind get kind;

  /// When it reached the family; null only for an exam mark from an older API.
  DateTime? get releasedAt;
}

/// A released exam mark, with the period and subject it belongs to.
final class RecentExamMark extends RecentGrade {
  const RecentExamMark(this.entry);

  final ReleasedMarkEntry entry;

  @override
  GradeKind get kind => GradeKind.exam;

  @override
  DateTime? get releasedAt => entry.assessment.releasedAt;
}

/// A published assignment (coursework) grade.
final class RecentAssignmentGrade extends RecentGrade {
  const RecentAssignmentGrade(this.grade);

  final PublishedGrade grade;

  @override
  GradeKind get kind => GradeKind.assignment;

  @override
  DateTime? get releasedAt => grade.publishedAt;
}

/// [grades] and every released exam mark in [marks] as one list, newest first. Ties keep exam
/// marks ahead of assignment grades and each source's own order; an exam mark without a release
/// time (an older API) sorts after everything dated.
List<RecentGrade> mergeRecentGrades({
  required List<PublishedGrade> grades,
  required List<ReleasedMarkPeriod> marks,
}) {
  final items = <RecentGrade>[
    for (final entry in releasedMarkEntries(marks)) RecentExamMark(entry),
    for (final grade in grades) RecentAssignmentGrade(grade),
  ];
  final order = {for (final (i, item) in items.indexed) item: i};
  final epoch = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
  items.sort((a, b) {
    final byTime = (b.releasedAt ?? epoch).compareTo(a.releasedAt ?? epoch);
    return byTime != 0 ? byTime : order[a]!.compareTo(order[b]!);
  });
  return items;
}
