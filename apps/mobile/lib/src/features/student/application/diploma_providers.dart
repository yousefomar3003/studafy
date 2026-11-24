import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/diploma_client.dart';
import '../domain/diploma_prediction.dart';

/// [StudentDiplomaClient] on its own [authenticatedDio], like `studentPredictedGradesClientProvider`.
final studentDiplomaClientProvider = Provider<StudentDiplomaClient>((ref) {
  return StudentDiplomaClient(authenticatedDio(ref));
});

/// A student's visible IB Diploma predicted totals by year — their own or a parent's child.
final studentDiplomaPredictionProvider = FutureProvider.autoDispose
    .family<List<DiplomaPredictionYear>, String>((ref, studentId) {
      return ref.watch(studentDiplomaClientProvider).fetch(studentId);
    });
