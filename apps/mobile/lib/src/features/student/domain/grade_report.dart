import '../../../core/api/generated/models/cumulative_grade_summary.dart';
import '../../../core/api/generated/models/published_grade.dart';
import '../../../core/api/generated/models/published_grade_snapshot.dart';
import '../../../core/api/generated/models/published_term_summary.dart';
import '../../../core/api/generated/models/term.dart';
import '../../../core/api/generated/models/term_status.dart';
import '../../../core/offline/cached_value.dart';

/// The outcome of loading the student grades screen for one term, once loading itself has
/// finished — the same three-state shape [TimetableWeekStatus](`timetable_week.dart`) uses, for
/// the same reason.
///
/// [GradeReportReady] carries a real, possibly-stale [GradeReport] (see [CachedValue.isStale]).
/// [GradeReportUnavailable] is a distinct non-error state: the screen needs the signed-in
/// student id (`student_context_providers.dart`'s `currentStudentIdProvider`, a known gap) and
/// the school to have at least one academic term — neither is a failed fetch when missing.
sealed class GradeReportStatus {
  const GradeReportStatus();
}

class GradeReportReady extends GradeReportStatus {
  const GradeReportReady(this.value);

  final CachedValue<GradeReport> value;
}

class GradeReportUnavailable extends GradeReportStatus {
  const GradeReportUnavailable();
}

/// One term's published grades as the screen renders them: the per-subject breakdown plus the
/// term and cumulative summaries, straight off the published-grades read API.
///
/// Parity note (acceptance criterion "parity with web read API verified"): the only read API for
/// a student's grades is `GET /api/grades/published/students/{studentId}/terms/{termId}`
/// (`apps/api/src/modules/grades/published`). It already filters to `status = 'published' AND
/// published_at IS NOT NULL` server-side (`@studafy/grades-reporting` `loadPublishedGradeRows`),
/// so "only published grades render" is enforced at the source — this layer renders exactly the
/// `grades` array it is handed and derives nothing from anywhere else. The per-subject
/// [SubjectGrades.weightedAverage] replicates that same package's `calculateClasses` formula
/// (weight-weighted mean of `score / max_score * 100`), because the snapshot returns the raw
/// grade rows and the term/cumulative summaries but not the per-class aggregate.
class GradeReport {
  const GradeReport({
    required this.term,
    required this.subjects,
    required this.termSummary,
    required this.cumulativeSummary,
  });

  final Term term;

  /// One entry per subject (course), ascending by course name. Empty when the term has no
  /// published grades yet.
  final List<SubjectGrades> subjects;

  final PublishedTermSummary termSummary;
  final CumulativeGradeSummary cumulativeSummary;

  bool get isEmpty => subjects.isEmpty;
}

/// One subject's published grades for the term: its identity, the credit-weighted average across
/// its scored entries, and the individual entries that make up the category breakdown.
class SubjectGrades {
  const SubjectGrades({
    required this.courseId,
    required this.courseName,
    required this.courseCode,
    required this.classCode,
    required this.creditHours,
    required this.entries,
    required this.weightedAverage,
  });

  final String courseId;
  final String courseName;
  final String courseCode;
  final String classCode;
  final num creditHours;

  /// The graded categories for this subject, ascending by publish time then label.
  final List<PublishedGrade> entries;

  /// Weight-weighted mean of `score / max_score * 100` over the entries that carry a score, or
  /// null when none of them do. Mirrors `@studafy/grades-reporting` `calculateClasses`.
  final double? weightedAverage;
}

/// Assembles [snapshot] into a [GradeReport] for [term]. Pure — no clock, no I/O — so the
/// grouping and the weighted-average maths are unit-testable on their own.
GradeReport assembleGradeReport({
  required Term term,
  required PublishedGradeSnapshot snapshot,
}) {
  final byCourse = <String, List<PublishedGrade>>{};
  for (final grade in snapshot.grades) {
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

  return GradeReport(
    term: term,
    subjects: subjects,
    termSummary: snapshot.termSummary,
    cumulativeSummary: snapshot.cumulativeSummary,
  );
}

/// Weight-weighted mean of `score / max_score * 100` across [entries] that carry a score, or
/// null when the total weight of scored entries is zero. Kept byte-for-byte in step with
/// `@studafy/grades-reporting` `calculateClasses` so a subject row reconciles with the web read
/// API's own class aggregate.
double? weightedSubjectAverage(List<PublishedGrade> entries) {
  var weighted = 0.0;
  var totalWeight = 0.0;
  for (final entry in entries) {
    final score = entry.score;
    if (score == null) continue;
    final weight = entry.weight.toDouble();
    weighted += (score.toDouble() / entry.maxScore.toDouble()) * 100 * weight;
    totalWeight += weight;
  }
  if (totalWeight == 0) return null;
  return weighted / totalWeight;
}

/// The term the screen defaults to when the student hasn't picked one: the active term if the
/// year has one, else the last term by sequence number. [terms] must be ascending by
/// [Term.sequenceNumber] and non-empty.
Term defaultGradeTerm(List<Term> terms) {
  for (final term in terms) {
    if (term.status == TermStatus.active) return term;
  }
  return terms.last;
}
