/// Domain models for a student's Tawjihi equivalency estimate
/// (`GET /api/grading/students/{studentId}/equivalency`; OpenAPI schema `StudentEquivalency`) and
/// multi-year results (`GET /api/grading/students/{studentId}/multi-year-results`; schema
/// `StudentMultiYearResults`).
///
/// An equivalency figure is an ESTIMATE under the school's own editable rules, which the school
/// confirms — never an official Ministry of Education conversion; the app always says so.
///
/// Hand-written like `graduation_requirements.dart` and parsed defensively: an unknown status,
/// type or issue code, or a missing field, never throws, so an older app keeps working when the
/// API adds to it.
library;

/// The estimate's outcome. [unknown] is a value a newer API might send: shown neutrally.
enum EquivalencyStatus {
  estimated,
  incomplete,
  notEligible,
  unknown;

  static EquivalencyStatus fromWire(Object? value) => switch (value) {
    'estimated' => estimated,
    'incomplete' => incomplete,
    'not_eligible' => notEligible,
    _ => unknown,
  };
}

/// Where one part of the estimate stands.
enum EquivalencyPartStatus {
  counted,
  missing,
  skipped,
  notEligible,
  unknown;

  static EquivalencyPartStatus fromWire(Object? value) => switch (value) {
    'counted' => counted,
    'missing' => missing,
    'skipped' => skipped,
    'not_eligible' => notEligible,
    _ => unknown,
  };
}

/// How an issue weighs on the estimate: data still to come, a rule that rules it out, or a note.
enum EquivalencyIssueKind {
  missing,
  notEligible,
  note,
  unknown;

  static EquivalencyIssueKind fromWire(Object? value) => switch (value) {
    'missing' => missing,
    'not_eligible' => notEligible,
    'note' => note,
    _ => unknown,
  };
}

/// One exam result considered by a subject-grades part (IGCSE, A Level...).
class EquivalencySubjectStep {
  const EquivalencySubjectStep({
    required this.subjectName,
    required this.examName,
    required this.grade,
    required this.percentage,
    required this.counted,
    required this.requiredSubject,
  });

  factory EquivalencySubjectStep.fromJson(Map<String, Object?> json) =>
      EquivalencySubjectStep(
        subjectName: _map(json['subject'])['name'] as String? ?? '',
        examName: _map(json['exam'])['name'] as String? ?? '',
        grade: json['grade'] as String? ?? '',
        percentage: _num(json['percentage']),
        counted: json['counted'] == true,
        requiredSubject: json['required_subject'] == true,
      );

  final String subjectName;
  final String examName;
  final String grade;

  /// Null when the grade has no percentage in the school's table.
  final double? percentage;
  final bool counted;
  final bool requiredSubject;
}

/// One weighted part of an estimate (subject grades, the IB total, the GPA, an exam total).
class EquivalencyPart {
  const EquivalencyPart({
    required this.index,
    required this.label,
    required this.type,
    required this.weight,
    required this.status,
    required this.percentage,
    required this.share,
    required this.sourceValue,
    required this.sourceMax,
    required this.subjects,
  });

  factory EquivalencyPart.fromJson(Map<String, Object?> json) =>
      EquivalencyPart(
        index: (json['index'] as num?)?.toInt() ?? 0,
        label: json['label'] as String? ?? '',
        type: json['type'] as String? ?? '',
        weight: _num(json['weight']) ?? 0,
        status: EquivalencyPartStatus.fromWire(json['status']),
        percentage: _num(json['percentage']),
        share: _num(json['share']),
        sourceValue: _num(json['source_value']),
        sourceMax: _num(json['source_max']),
        subjects: [
          for (final step in _list(json['subjects']))
            EquivalencySubjectStep.fromJson(step),
        ],
      );

  final int index;
  final String label;

  /// The wire type (`exam_subjects`, `diploma_total`, `gpa`, `exam_total` or a newer one).
  final String type;
  final double weight;
  final EquivalencyPartStatus status;
  final double? percentage;

  /// The part's share of the estimate in percent; null unless the estimate was made.
  final double? share;

  /// The value converted: the IB total, the GPA or the exam total.
  final double? sourceValue;
  final double? sourceMax;
  final List<EquivalencySubjectStep> subjects;
}

/// Why the estimate is missing, not eligible, or worth a note.
class EquivalencyIssue {
  const EquivalencyIssue({
    required this.code,
    required this.kind,
    required this.partIndex,
    required this.subjectName,
    required this.examName,
    required this.grade,
    required this.required,
    required this.actual,
  });

  factory EquivalencyIssue.fromJson(Map<String, Object?> json) =>
      EquivalencyIssue(
        code: json['code'] as String? ?? '',
        kind: EquivalencyIssueKind.fromWire(json['kind']),
        partIndex: (json['part_index'] as num?)?.toInt(),
        subjectName: _map(json['subject'])['name'] as String?,
        examName: _map(json['exam'])['name'] as String?,
        grade: json['grade'] as String?,
        required: _num(json['required']),
        actual: _num(json['actual']),
      );

  /// The wire code (`TOO_FEW_SUBJECTS`...); an unknown one is shown with a generic sentence.
  final String code;
  final EquivalencyIssueKind kind;
  final int? partIndex;
  final String? subjectName;
  final String? examName;
  final String? grade;
  final double? required;
  final double? actual;
}

/// The estimate under one of the school's rule sets.
class EquivalencyEstimate {
  const EquivalencyEstimate({
    required this.setName,
    required this.sourceSystem,
    required this.status,
    required this.percentage,
    required this.parts,
    required this.issues,
  });

  factory EquivalencyEstimate.fromJson(Map<String, Object?> json) {
    final set = _map(json['set']);
    return EquivalencyEstimate(
      setName: set['name'] as String? ?? '',
      sourceSystem: set['source_system'] as String? ?? '',
      status: EquivalencyStatus.fromWire(json['status']),
      percentage: _num(json['percentage']),
      parts: [
        for (final part in _list(json['parts'])) EquivalencyPart.fromJson(part),
      ],
      issues: [
        for (final issue in _list(json['issues']))
          EquivalencyIssue.fromJson(issue),
      ],
    );
  }

  final String setName;
  final String sourceSystem;
  final EquivalencyStatus status;

  /// The estimated Tawjihi-equivalent percentage; null unless [status] is estimated.
  final double? percentage;
  final List<EquivalencyPart> parts;
  final List<EquivalencyIssue> issues;
}

/// The response's `estimates`: empty when no set applies or none is shown to students and parents.
List<EquivalencyEstimate> parseStudentEquivalency(Object? body) => [
  for (final estimate in _list(_map(body)['estimates']))
    EquivalencyEstimate.fromJson(estimate),
];

// ---------------------------------------------------------------------------------------------
// Multi-year results
// ---------------------------------------------------------------------------------------------

enum MultiYearStatus {
  complete,
  pending,
  incomplete,
  unknown;

  static MultiYearStatus fromWire(Object? value) => switch (value) {
    'complete' => complete,
    'pending' => pending,
    'incomplete' => incomplete,
    _ => unknown,
  };
}

enum MultiYearYearStatus {
  finalized,
  incomplete,
  pending,
  missing,
  unknown;

  static MultiYearYearStatus fromWire(Object? value) => switch (value) {
    'finalized' => finalized,
    'incomplete' => incomplete,
    'pending' => pending,
    'missing' => missing,
    _ => unknown,
  };
}

/// One weighted grade level of a multi-year result.
class MultiYearYear {
  const MultiYearYear({
    required this.gradeLevelName,
    required this.weight,
    required this.share,
    required this.status,
    required this.academicYearName,
    required this.overallPercentage,
  });

  factory MultiYearYear.fromJson(Map<String, Object?> json) => MultiYearYear(
    gradeLevelName: _map(json['grade_level'])['name'] as String? ?? '',
    weight: _num(json['weight']) ?? 0,
    share: _num(json['share']) ?? 0,
    status: MultiYearYearStatus.fromWire(json['status']),
    academicYearName: _map(json['academic_year'])['name'] as String?,
    overallPercentage: _num(json['overall_percentage']),
  );

  final String gradeLevelName;
  final double weight;

  /// The year's share of the result in percent.
  final double share;
  final MultiYearYearStatus status;
  final String? academicYearName;
  final double? overallPercentage;
}

/// One subject's weighted result across the years it was taken.
class MultiYearSubject {
  const MultiYearSubject({
    required this.name,
    required this.percentage,
    required this.yearsCounted,
    required this.byYear,
  });

  factory MultiYearSubject.fromJson(Map<String, Object?> json) =>
      MultiYearSubject(
        name: json['name'] as String? ?? '',
        percentage: _num(json['percentage']),
        yearsCounted: (json['years_counted'] as num?)?.toInt() ?? 0,
        byYear: [
          for (final year in _list(json['by_year'])) _num(year['percentage']),
        ],
      );

  final String name;

  /// Null until every year is finalized.
  final double? percentage;
  final int yearsCounted;

  /// Each configured year's figure, in order.
  final List<double?> byYear;
}

/// A result weighted across several grade levels ("Grade 11 40% + Grade 12 60%").
class MultiYearResult {
  const MultiYearResult({
    required this.name,
    required this.status,
    required this.overallPercentage,
    required this.years,
    required this.subjects,
  });

  factory MultiYearResult.fromJson(Map<String, Object?> json) =>
      MultiYearResult(
        name: _map(json['config'])['name'] as String? ?? '',
        status: MultiYearStatus.fromWire(json['status']),
        overallPercentage: _num(json['overall_percentage']),
        years: [
          for (final year in _list(json['years'])) MultiYearYear.fromJson(year),
        ],
        subjects: [
          for (final subject in _list(json['subjects']))
            MultiYearSubject.fromJson(subject),
        ],
      );

  final String name;
  final MultiYearStatus status;

  /// Null until every year is finalized.
  final double? overallPercentage;
  final List<MultiYearYear> years;
  final List<MultiYearSubject> subjects;
}

/// The response's `results`: empty when no configuration applies or none is shown.
List<MultiYearResult> parseStudentMultiYearResults(Object? body) => [
  for (final result in _list(_map(body)['results']))
    MultiYearResult.fromJson(result),
];

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final item in value)
      if (item is Map) Map<String, Object?>.from(item),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

double? _num(Object? value) => value is num ? value.toDouble() : null;
