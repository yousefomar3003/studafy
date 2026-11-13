import '../../../core/api/generated/models/published_grade.dart';
import '../../student/domain/grade_report.dart';

/// Groups a linked child's published-grade rows into one [SubjectGrades] per course, the same
/// shape the student grades screen renders through `SubjectGradesCard`.
///
/// This is the parent-scope sibling of `assembleGradeReport` (`grade_report.dart`): the child
/// breakdown endpoint (`GET /api/reports/children/{studentId}/breakdown`) hands back the same
/// [PublishedGrade] rows the student published-grades endpoint does, so the grouping, the
/// per-subject [weightedSubjectAverage] and the ordering are kept identical here — a parent sees
/// exactly the per-subject numbers the child sees. It stays a separate function only because the
/// breakdown carries no cumulative summary, so it cannot build a full [GradeReport].
List<SubjectGrades> groupChildSubjects(List<PublishedGrade> grades) {
  final byCourse = <String, List<PublishedGrade>>{};
  for (final grade in grades) {
    byCourse.putIfAbsent(grade.course.id, () => []).add(grade);
  }

  final subjects = <SubjectGrades>[];
  for (final entry in byCourse.entries) {
    final rows = entry.value
      ..sort((a, b) {
        final byTime = a.publishedAt.compareTo(b.publishedAt);
        return byTime != 0 ? byTime : a.label.compareTo(b.label);
      });
    final first = rows.first;
    subjects.add(
      SubjectGrades(
        courseId: first.course.id,
        courseName: first.course.name,
        courseCode: first.course.code,
        classCode: first.classValue.code,
        creditHours: first.course.creditHours,
        entries: rows,
        weightedAverage: weightedSubjectAverage(rows),
      ),
    );
  }
  subjects.sort((a, b) => a.courseName.toLowerCase().compareTo(b.courseName.toLowerCase()));
  return subjects;
}
