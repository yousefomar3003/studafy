/// Domain model for a student's approved marks (`GET /api/grading/students/{studentId}/marks`,
/// OpenAPI tag `Results`): every mark school leadership has released — a whole period's approved
/// mark sheet, or a single assessment approved on its own before the rest of its period — by
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
    this.descriptorLabel,
  });

  factory ReleasedMarkAttempt.fromJson(Map<String, Object?> json) =>
      ReleasedMarkAttempt(
        attempt: (json['attempt'] as num?)?.toInt() ?? 1,
        status: ReleasedMarkStatus.fromWire(json['status']),
        score: _num(json['score']),
        descriptorLabel: json['descriptor_label'] as String?,
      );

  /// 1, or 2 for a retake.
  final int attempt;
  final ReleasedMarkStatus status;
  final double? score;

  /// Descriptive subjects (no marks): the descriptor the skill was given.
  final String? descriptorLabel;
}

class ReleasedAssessment {
  const ReleasedAssessment({
    required this.id,
    required this.name,
    required this.maxMarks,
    required this.attempts,
    this.assessmentDate,
    this.releasedAt,
  });

  factory ReleasedAssessment.fromJson(Map<String, Object?> json) =>
      ReleasedAssessment(
        id: json['assessment_id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        maxMarks: _num(json['max_marks']) ?? 0,
        assessmentDate: DateTime.tryParse(
          json['assessment_date'] as String? ?? '',
        ),
        releasedAt: DateTime.tryParse(json['released_at'] as String? ?? ''),
        attempts: [
          for (final row in _list(json['attempts']))
            ReleasedMarkAttempt.fromJson(row),
        ],
      );

  final String id;
  final String name;
  final double maxMarks;

  /// The day the assessment was sat, when the school set one (a calendar date, no time).
  final DateTime? assessmentDate;

  /// When its marks reached the family: its own approval, or its period sheet's. Null from an
  /// older API that did not send it.
  final DateTime? releasedAt;

  /// The first attempt, then the retake when there is one.
  final List<ReleasedMarkAttempt> attempts;

  /// The attempt that counts for a summary line: the retake when there is one.
  ReleasedMarkAttempt? get latestAttempt =>
      attempts.isEmpty ? null : attempts.last;

  /// The mark as a percentage of [maxMarks], for tinting; null when not a scored mark.
  double? get latestPercentage {
    final attempt = latestAttempt;
    final score = attempt?.score;
    if (attempt == null ||
        attempt.status != ReleasedMarkStatus.graded ||
        attempt.descriptorLabel != null ||
        score == null ||
        maxMarks <= 0) {
      return null;
    }
    return score / maxMarks * 100;
  }
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
    this.periodApproved = true,
  });

  factory ReleasedMarkSubject.fromJson(Map<String, Object?> json) =>
      ReleasedMarkSubject(
        id: json['subject_id'] as String? ?? '',
        code: json['subject_code'] as String? ?? '',
        name: json['subject_name'] as String? ?? '',
        approvedAt: DateTime.tryParse(json['approved_at'] as String? ?? ''),
        // An older API only ever released whole approved periods.
        periodApproved: json['period_approved'] as bool? ?? true,
        categories: [
          for (final row in _list(json['categories']))
            ReleasedMarkCategory.fromJson(row),
        ],
      );

  final String id;
  final String code;
  final String name;

  /// When the whole period's mark sheet was approved; null while only single assessments are out.
  final DateTime? approvedAt;

  /// False while assessments are released one at a time (say, the first exam before the rest of
  /// the term): more marks are still to come and nothing here is a term result.
  final bool periodApproved;
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

/// One released assessment with where it sits: its period, subject and category. The flat form
/// the summary cards list, newest first.
class ReleasedMarkEntry {
  const ReleasedMarkEntry({
    required this.period,
    required this.subject,
    required this.category,
    required this.assessment,
  });

  final ReleasedMarkPeriod period;
  final ReleasedMarkSubject subject;
  final ReleasedMarkCategory category;
  final ReleasedAssessment assessment;
}

/// Every released assessment in [periods], most recently released first (ties, and an older API
/// without release times, keep the API's own order).
List<ReleasedMarkEntry> releasedMarkEntries(List<ReleasedMarkPeriod> periods) {
  final entries = [
    for (final period in periods)
      for (final subject in period.subjects)
        for (final category in subject.categories)
          for (final assessment in category.assessments)
            if (assessment.attempts.isNotEmpty)
              ReleasedMarkEntry(
                period: period,
                subject: subject,
                category: category,
                assessment: assessment,
              ),
  ];
  final order = {for (final (i, e) in entries.indexed) e: i};
  final epoch = DateTime.fromMillisecondsSinceEpoch(0);
  entries.sort((a, b) {
    final byTime = (b.assessment.releasedAt ?? epoch).compareTo(
      a.assessment.releasedAt ?? epoch,
    );
    return byTime != 0 ? byTime : order[a]!.compareTo(order[b]!);
  });
  return entries;
}

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final row in value)
      if (row is Map) Map<String, Object?>.from(row),
];

double? _num(Object? value) => value is num ? value.toDouble() : null;
