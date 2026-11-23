/// Domain model for a student's external exam results and test scores
/// (`GET /api/grading/students/{studentId}/external-exam-results`; OpenAPI schema
/// `ExternalExamResult`): SAT, IELTS, IGCSE finals, Tawjihi and the like, recorded by the school.
///
/// Hand-written like `transcript.dart` and parsed defensively: an unknown or missing field never
/// throws, so an older app keeps working when the API adds to the shape.
library;

/// One component's score: a number (`numericScore`) or a grade (`labelScore`).
class ExternalExamScore {
  const ExternalExamScore({
    required this.componentName,
    required this.numericScore,
    required this.labelScore,
    required this.maxScore,
  });

  factory ExternalExamScore.fromJson(Map<String, Object?> json) =>
      ExternalExamScore(
        componentName: json['component_name'] as String? ?? '',
        numericScore: _num(json['numeric_score']),
        labelScore: json['label_score'] as String?,
        maxScore: _num(json['max_score']),
      );

  final String componentName;
  final double? numericScore;
  final String? labelScore;
  final double? maxScore;
}

/// One sitting of an external exam, optionally for one subject.
class ExternalExamResult {
  const ExternalExamResult({
    required this.id,
    required this.examName,
    required this.subjectName,
    required this.satOn,
    required this.totalScore,
    required this.totalMax,
    required this.note,
    required this.scores,
  });

  /// Null for a row without an id (never sent by the API; skipped by [parseExternalExamResults]).
  static ExternalExamResult? fromJson(Map<String, Object?> json) {
    final id = json['id'];
    if (id is! String) return null;
    final exam = _map(json['exam']);
    final subject = json['subject'] is Map ? _map(json['subject']) : null;
    return ExternalExamResult(
      id: id,
      examName: exam['name'] as String? ?? '',
      subjectName: subject?['name'] as String?,
      satOn: DateTime.tryParse(json['sat_on'] as String? ?? ''),
      totalScore: _num(json['total_score']),
      totalMax: _num(exam['total_max']),
      note: json['note'] as String?,
      scores: [
        for (final score in _list(json['scores']))
          ExternalExamScore.fromJson(score),
      ],
    );
  }

  final String id;
  final String examName;

  /// Set for a per-subject exam (IGCSE Mathematics).
  final String? subjectName;
  final DateTime? satOn;

  /// Worked out by the API; null when the exam has no total or a part was not scored.
  final double? totalScore;
  final double? totalMax;
  final String? note;
  final List<ExternalExamScore> scores;
}

/// The `results` of the list response, newest sitting first as the API sends them.
List<ExternalExamResult> parseExternalExamResults(Object? body) {
  final map = _map(body);
  return [
    for (final row in _list(map['results'])) ?ExternalExamResult.fromJson(row),
  ];
}

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final item in value)
      if (item is Map) Map<String, Object?>.from(item),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

double? _num(Object? value) => value is num ? value.toDouble() : null;
