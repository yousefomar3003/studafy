/// Domain model for a subject coordinator's overview (`GET /api/grading/my-coordinated-subjects`,
/// OpenAPI schema `MyCoordinatedSubjects`, 000260): the subjects the signed-in teacher coordinates
/// this year, each across the sections it covers.
///
/// Parsed defensively like `mark_sheet.dart`: a missing field means an older server, an unknown
/// sheet status degrades to [MarkSheetPeriodStatus.unknown].
library;

import 'mark_sheet.dart';

/// `GET /api/grading/my-coordinated-subjects`.
class CoordinatedSubjects {
  const CoordinatedSubjects({
    required this.academicYearId,
    required this.subjects,
  });

  factory CoordinatedSubjects.fromJson(Map<String, Object?> json) =>
      CoordinatedSubjects(
        academicYearId: json['academic_year_id'] as String?,
        subjects: [
          for (final subject in _list(json['subjects']))
            CoordinatedSubject.fromJson(subject),
        ],
      );

  /// Null when the school has no active or finalized year yet.
  final String? academicYearId;
  final List<CoordinatedSubject> subjects;

  bool get isEmpty => subjects.isEmpty;
}

class CoordinatedSubject {
  const CoordinatedSubject({
    required this.coordinatorId,
    required this.subjectId,
    required this.subjectCode,
    required this.subjectName,
    required this.gradeLevelIds,
    required this.sections,
  });

  factory CoordinatedSubject.fromJson(Map<String, Object?> json) =>
      CoordinatedSubject(
        coordinatorId: json['coordinator_id'] as String? ?? '',
        subjectId: json['subject_id']! as String,
        subjectCode: json['subject_code'] as String? ?? '',
        subjectName: json['subject_name'] as String? ?? '',
        gradeLevelIds: [
          for (final id
              in (json['grade_level_ids'] as List<Object?>?) ??
                  const <Object?>[])
            if (id is String) id,
        ],
        sections: [
          for (final section in _list(json['sections']))
            CoordinatedSection.fromJson(section),
        ],
      );

  final String coordinatorId;
  final String subjectId;
  final String subjectCode;
  final String subjectName;

  /// The grade levels covered; empty means every grade level taught the subject.
  final List<String> gradeLevelIds;
  final List<CoordinatedSection> sections;
}

/// One section the subject is taught in.
class CoordinatedSection {
  const CoordinatedSection({
    required this.sectionId,
    required this.sectionName,
    required this.gradeLevelId,
    required this.gradeLevelName,
    required this.teacherNames,
    required this.studentCount,
    required this.averagePercentage,
    required this.completeCount,
    required this.sheets,
    required this.results,
  });

  factory CoordinatedSection.fromJson(Map<String, Object?> json) =>
      CoordinatedSection(
        sectionId: json['section_id']! as String,
        sectionName: json['section_name'] as String? ?? '',
        gradeLevelId: json['grade_level_id'] as String? ?? '',
        gradeLevelName: json['grade_level_name'] as String? ?? '',
        teacherNames: [
          for (final name
              in (json['teacher_names'] as List<Object?>?) ?? const <Object?>[])
            if (name is String) name,
        ],
        studentCount: (json['student_count'] as num?)?.toInt() ?? 0,
        averagePercentage: _num(json['average_percentage']),
        completeCount: (json['complete_count'] as num?)?.toInt() ?? 0,
        sheets: [
          for (final sheet in _list(json['sheets']))
            (
              termId: sheet['term_id'] as String?,
              termName: sheet['term_name'] as String?,
              status: MarkSheetPeriodStatus.fromWire(sheet['status']),
            ),
        ],
        results: [
          for (final result in _list(json['results']))
            CoordinatedResult.fromJson(result),
        ],
      );

  final String sectionId;
  final String sectionName;
  final String gradeLevelId;
  final String gradeLevelName;
  final List<String> teacherNames;

  /// Students taking the subject (exempt ones are not counted).
  final int studentCount;

  /// The mean of the students' current percentages from the marks recorded so far (provisional
  /// where incomplete); null before any mark.
  final double? averagePercentage;

  /// Students whose current result is complete.
  final int completeCount;

  /// Each period's mark-sheet status; `termId` null is the annual period.
  final List<({String? termId, String? termName, MarkSheetPeriodStatus status})>
  sheets;

  /// The subject's finalized results in the section, one per finalized period.
  final List<CoordinatedResult> results;
}

/// The subject's finalized results for one period of a section.
class CoordinatedResult {
  const CoordinatedResult({
    required this.termId,
    required this.termName,
    required this.averagePercentage,
    required this.studentCount,
  });

  factory CoordinatedResult.fromJson(Map<String, Object?> json) =>
      CoordinatedResult(
        termId: json['term_id'] as String?,
        termName: json['term_name'] as String?,
        averagePercentage: _num(json['average_percentage']),
        studentCount: (json['student_count'] as num?)?.toInt() ?? 0,
      );

  /// Null for the annual result.
  final String? termId;
  final String? termName;
  final double? averagePercentage;

  /// Students with a complete result.
  final int studentCount;
}

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    if (item is Map) Map<String, Object?>.from(item),
];

double? _num(Object? value) => value is num ? value.toDouble() : null;
