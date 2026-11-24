/// A student's IB Diploma predicted total by year (`GET /api/grading/students/{studentId}/diploma`,
/// OpenAPI tag `Results`, 000263). Hand-written like `academic_results.dart`; JSON follows the
/// API's `StudentDiploma` schema. Students and parents only receive a year's prediction while the
/// school shows predicted grades to them.
library;

import 'academic_results.dart';

/// One year whose grade uses the IB Diploma total.
class DiplomaPredictionYear {
  const DiplomaPredictionYear({
    required this.yearName,
    required this.gradeLevelName,
    required this.sectionName,
    required this.predictedResult,
  });

  factory DiplomaPredictionYear.fromJson(Map<String, Object?> json) =>
      DiplomaPredictionYear(
        yearName: json['academic_year_name'] as String? ?? '',
        gradeLevelName: json['grade_level_name'] as String? ?? '',
        sectionName: json['section_name'] as String? ?? '',
        predictedResult: DiplomaOutcome.fromJson(json['predicted_result']),
      );

  final String yearName;
  final String gradeLevelName;
  final String sectionName;

  /// The predicted total, core points and status; null when the school does not show it.
  final DiplomaOutcome? predictedResult;
}

/// The years that carry a predicted total, newest first.
List<DiplomaPredictionYear> parseDiplomaPredictions(
  Map<String, Object?>? body,
) => [
  for (final row in (body?['years'] as List<Object?>?) ?? const <Object?>[])
    if (row is Map)
      DiplomaPredictionYear.fromJson(Map<String, Object?>.from(row)),
].where((year) => year.predictedResult != null).toList();
