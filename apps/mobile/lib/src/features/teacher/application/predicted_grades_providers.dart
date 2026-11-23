import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/predicted_grades_client.dart';
import '../domain/predicted_grades.dart';

final predictedGradesClientProvider = Provider<PredictedGradesClient>((ref) {
  return PredictedGradesClient(authenticatedDio(ref));
});

/// The section and subject a class is taught to (null when it has no section).
final classGradingTargetProvider = FutureProvider.autoDispose
    .family<({String sectionId, String subjectId})?, String>((ref, classId) {
      return ref.watch(predictedGradesClientProvider).classTarget(classId);
    });

/// A section, one of its subjects, and a period (null term = the whole year).
typedef PredictedGradesKey = ({
  String sectionId,
  String subjectId,
  String? termId,
});

final predictedGradesProvider = FutureProvider.autoDispose
    .family<SectionPredictedGrades, PredictedGradesKey>((ref, key) {
      return ref
          .watch(predictedGradesClientProvider)
          .fetch(key.sectionId, key.subjectId, termId: key.termId);
    });
