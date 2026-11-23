/// A student's predicted grades by academic year, from
/// `GET /api/grading/students/{studentId}/predicted-grades` (`StudentPredictedGrades`, 000254).
///
/// The API returns a year to the student or a parent only while the school shows predicted grades
/// to families, and never the teacher's note. Parsed defensively: unknown or missing fields degrade
/// to empty values rather than throwing.
library;

class PredictedGradesYear {
  const PredictedGradesYear({
    required this.yearName,
    required this.gradeLevelName,
    required this.sectionName,
    required this.grades,
  });

  factory PredictedGradesYear.fromJson(Map<String, Object?> json) {
    return PredictedGradesYear(
      yearName: json['academic_year_name'] as String? ?? '',
      gradeLevelName: json['grade_level_name'] as String?,
      sectionName: json['section_name'] as String?,
      grades: [
        for (final grade in _list(json['grades']))
          if (grade['grade_label'] is String)
            PredictedGrade(
              subjectName: grade['subject_name'] as String? ?? '',
              termName: grade['term_name'] as String?,
              gradeLabel: grade['grade_label']! as String,
            ),
      ],
    );
  }

  final String yearName;
  final String? gradeLevelName;
  final String? sectionName;
  final List<PredictedGrade> grades;
}

class PredictedGrade {
  const PredictedGrade({
    required this.subjectName,
    required this.termName,
    required this.gradeLabel,
  });

  final String subjectName;

  /// Null for the whole year.
  final String? termName;
  final String gradeLabel;
}

/// The years that have at least one predicted grade, as the API ordered them (newest first).
List<PredictedGradesYear> parsePredictedGradeYears(
  Map<String, Object?>? json,
) => [
  for (final year in _list(json?['years'])) PredictedGradesYear.fromJson(year),
].where((year) => year.grades.isNotEmpty).toList();

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    if (item is Map) Map<String, Object?>.from(item),
];
