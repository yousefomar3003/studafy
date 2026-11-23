/// A section's predicted grades in one subject and period, from
/// `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/predicted-grades`
/// (`SectionPredictedGrades`, 000254). Hand-written and parsed defensively like
/// `report_comments.dart`: a missing or unexpected field degrades to an empty or disabled value
/// rather than throwing, so an older app keeps working against a newer API.
library;

class SectionPredictedGrades {
  const SectionPredictedGrades({
    required this.subjectName,
    required this.sectionLabel,
    required this.termId,
    required this.enabled,
    required this.editable,
    required this.labels,
    required this.terms,
    required this.students,
  });

  factory SectionPredictedGrades.fromJson(Map<String, Object?> json) {
    final grade = json['grade_level_name'] as String? ?? '';
    final section = json['section_name'] as String? ?? '';
    return SectionPredictedGrades(
      subjectName: json['subject_name'] as String? ?? '',
      sectionLabel: [grade, section].where((s) => s.isNotEmpty).join(' '),
      termId: json['term_id'] as String?,
      enabled: json['enabled'] == true,
      editable: json['editable'] == true,
      labels: [
        for (final label in (json['labels'] as List<Object?>?) ?? const [])
          if (label is String && label.isNotEmpty) label,
      ],
      terms: [
        for (final term in _list(json['terms']))
          if (term['term_id'] is String)
            (
              termId: term['term_id']! as String,
              name: term['term_name'] as String? ?? '',
            ),
      ],
      students: [
        for (final student in _list(json['students']))
          if (student['student_id'] is String)
            (
              studentId: student['student_id']! as String,
              name:
                  '${student['first_name'] as String? ?? ''} '
                          '${student['last_name'] as String? ?? ''}'
                      .trim(),
              gradeLabel: student['grade_label'] as String?,
            ),
      ],
    );
  }

  final String subjectName;

  /// "Year 13 A": the grade and section, for the title.
  final String sectionLabel;

  /// Null for the whole year.
  final String? termId;

  /// The grade's program records predicted grades this year.
  final bool enabled;

  /// Enabled, and the year is neither finalized nor archived.
  final bool editable;

  /// The subject's grade scale, highest first. Empty: any short label.
  final List<String> labels;
  final List<({String termId, String name})> terms;
  final List<({String studentId, String name, String? gradeLabel})> students;
}

/// The longest label the API accepts.
const predictedGradeLabelMaxLength = 40;

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    if (item is Map) Map<String, Object?>.from(item),
];
