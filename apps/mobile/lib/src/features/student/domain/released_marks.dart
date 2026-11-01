/// Domain model for a student's approved marks (`GET /api/grading/students/{studentId}/marks`,
/// OpenAPI tag `Results`): every mark from a mark sheet school leadership has approved, by
/// period (each term, then the annual period for year-long assessments such as a final exam),
/// subject and category (midterm, final exam, quizzes, …).
///
/// Hand-written for the same reason as `academic_results.dart`. JSON shapes follow the API's
/// `grading/schemas.ts` (`StudentReleasedMarks`).
library;

/// How one attempt at an assessment was marked.
enum ReleasedMarkStatus {
  graded,
  absent,
  excused,
  notApplicable;

  static ReleasedMarkStatus fromWire(Object? value) => switch (value) {
    'absent' => absent,
    'excused' => excused,
    'not_applicable' => notApplicable,
    _ => graded,
  };
}

class ReleasedMarkAttempt {
  const ReleasedMarkAttempt({
    required this.attempt,
    required this.status,
    required this.score,
  });

  factory ReleasedMarkAttempt.fromJson(Map<String, Object?> json) =>
      ReleasedMarkAttempt(
        attempt: (json['attempt'] as num?)?.toInt() ?? 1,
        status: ReleasedMarkStatus.fromWire(json['status']),
        score: _num(json['score']),
      );

  /// 1, or 2 for a retake.
  final int attempt;
  final ReleasedMarkStatus status;
  final double? score;
}

class ReleasedAssessment {
  const ReleasedAssessment({
    required this.id,
    required this.name,
    required this.maxMarks,
    required this.attempts,
  });

  factory ReleasedAssessment.fromJson(Map<String, Object?> json) =>
      ReleasedAssessment(
        id: json['assessment_id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        maxMarks: _num(json['max_marks']) ?? 0,
        attempts: [
          for (final row in _list(json['attempts']))
            ReleasedMarkAttempt.fromJson(row),
        ],
      );

  final String id;
  final String name;
  final double maxMarks;

  /// The first attempt, then the retake when there is one.
  final List<ReleasedMarkAttempt> attempts;
}

class ReleasedMarkCategory {
  const ReleasedMarkCategory({
    required this.id,
    required this.name,
    required this.kind,
    required this.assessments,
  });

  factory ReleasedMarkCategory.fromJson(Map<String, Object?> json) =>
      ReleasedMarkCategory(
        id: json['category_id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        kind: json['kind'] as String? ?? 'other',
        assessments: [
          for (final row in _list(json['assessments']))
            ReleasedAssessment.fromJson(row),
        ],
      );

  final String id;

  /// The school's own name for the category ("Midterm", "Final exam", …).
  final String name;

  /// `midterm`, `final_exam`, `quiz`, `homework`, … (`grading/schemas.ts` categoryKindSchema).
  final String kind;
  final List<ReleasedAssessment> assessments;
}

class ReleasedMarkSubject {
  const ReleasedMarkSubject({
    required this.id,
    required this.code,
    required this.name,
    required this.approvedAt,
    required this.categories,
  });

  factory ReleasedMarkSubject.fromJson(Map<String, Object?> json) =>
      ReleasedMarkSubject(
        id: json['subject_id'] as String? ?? '',
        code: json['subject_code'] as String? ?? '',
        name: json['subject_name'] as String? ?? '',
        approvedAt: DateTime.tryParse(json['approved_at'] as String? ?? ''),
        categories: [
          for (final row in _list(json['categories']))
            ReleasedMarkCategory.fromJson(row),
        ],
      );

  final String id;
  final String code;
  final String name;
  final DateTime? approvedAt;
  final List<ReleasedMarkCategory> categories;
}

/// One period of an academic year: a term, or the annual period ([termId] null).
class ReleasedMarkPeriod {
  const ReleasedMarkPeriod({
    required this.academicYearId,
    required this.academicYearName,
    required this.termId,
    required this.termName,
    required this.subjects,
  });

  factory ReleasedMarkPeriod.fromJson(Map<String, Object?> json) =>
      ReleasedMarkPeriod(
        academicYearId: json['academic_year_id'] as String? ?? '',
        academicYearName: json['academic_year_name'] as String? ?? '',
        termId: json['term_id'] as String?,
        termName: json['term_name'] as String?,
        subjects: [
          for (final row in _list(json['subjects']))
            ReleasedMarkSubject.fromJson(row),
        ],
      );

  final String academicYearId;
  final String academicYearName;
  final String? termId;
  final String? termName;
  final List<ReleasedMarkSubject> subjects;

  bool get isAnnual => termId == null;
}

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final row in value)
      if (row is Map) Map<String, Object?>.from(row),
];

double? _num(Object? value) => value is num ? value.toDouble() : null;
