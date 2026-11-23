/// Domain model for a student's graduation requirements checklist
/// (`GET /api/grading/students/{studentId}/graduation-requirements`; OpenAPI schema
/// `GraduationChecklist`): each requirement set the school shows to students and parents (a
/// diploma's credits, required subjects, a minimum GPA, an exam) and where the student stands.
///
/// Hand-written like `external_exam_results.dart` and parsed defensively: an unknown rule type or
/// status, or a missing field, never throws, so an older app keeps working when the API adds to it.
library;

/// Where a set or rule stands. [unknown] is a value a newer API might send: shown neutrally.
enum GraduationStatus {
  met,
  notMet,
  pending,
  unknown;

  static GraduationStatus fromWire(Object? value) => switch (value) {
    'met' => met,
    'not_met' => notMet,
    'pending' => pending,
    _ => unknown,
  };
}

/// The kind of rule. [unknown] is a type a newer API might send: shown with a generic label.
enum GraduationRuleType {
  totalCredits,
  groupCredits,
  subjectsPassed,
  cumulativeGpa,
  cumulativeAverage,
  externalExam,
  unknown;

  static GraduationRuleType fromWire(Object? value) => switch (value) {
    'total_credits' => totalCredits,
    'group_credits' => groupCredits,
    'subjects_passed' => subjectsPassed,
    'cumulative_gpa' => cumulativeGpa,
    'cumulative_average' => cumulativeAverage,
    'external_exam' => externalExam,
    _ => unknown,
  };
}

/// One rule of a set and where the student stands on it.
class GraduationRule {
  const GraduationRule({
    required this.type,
    required this.status,
    required this.groupName,
    required this.examName,
    required this.current,
    required this.required,
    required this.missingSubjects,
  });

  factory GraduationRule.fromJson(Map<String, Object?> json) => GraduationRule(
    type: GraduationRuleType.fromWire(json['type']),
    status: GraduationStatus.fromWire(json['status']),
    groupName: json['group_name'] as String?,
    examName: _map(json['external_exam'])['name'] as String?,
    current: _num(json['current']),
    required: _num(json['required']),
    missingSubjects: [
      for (final subject in _list(json['missing_subjects']))
        if (subject['name'] case final String name) name,
    ],
  );

  final GraduationRuleType type;
  final GraduationStatus status;

  /// The named group of subjects ("English") of a group rule.
  final String? groupName;

  /// The exam of an external exam rule.
  final String? examName;

  /// Credits earned, subjects passed, the cumulative GPA or average, or the best exam total.
  final double? current;

  /// What the rule asks for; null for an exam that only has to be recorded.
  final double? required;

  /// The group's subjects not passed yet (subjects passed rules).
  final List<String> missingSubjects;
}

/// One requirement set and where the student stands on it.
class GraduationSetChecklist {
  const GraduationSetChecklist({
    required this.name,
    required this.status,
    required this.rulesMet,
    required this.rulesTotal,
    required this.rules,
  });

  factory GraduationSetChecklist.fromJson(Map<String, Object?> json) =>
      GraduationSetChecklist(
        name: _map(json['set'])['name'] as String? ?? '',
        status: GraduationStatus.fromWire(json['status']),
        rulesMet: (json['rules_met'] as num?)?.toInt() ?? 0,
        rulesTotal: (json['rules_total'] as num?)?.toInt() ?? 0,
        rules: [
          for (final rule in _list(json['rules']))
            GraduationRule.fromJson(rule),
        ],
      );

  final String name;
  final GraduationStatus status;
  final int rulesMet;
  final int rulesTotal;
  final List<GraduationRule> rules;
}

/// The checklist's `sets`: empty when no set applies or none is shown to students and parents.
List<GraduationSetChecklist> parseGraduationChecklist(Object? body) => [
  for (final set in _list(_map(body)['sets']))
    GraduationSetChecklist.fromJson(set),
];

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final item in value)
      if (item is Map) Map<String, Object?>.from(item),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

double? _num(Object? value) => value is num ? value.toDouble() : null;
