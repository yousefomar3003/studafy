import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/predicted_grades_client.dart';
import '../domain/predicted_grades.dart';

/// [StudentPredictedGradesClient] on its own [authenticatedDio], like `transcriptClientProvider`.
final studentPredictedGradesClientProvider =
    Provider<StudentPredictedGradesClient>((ref) {
      return StudentPredictedGradesClient(authenticatedDio(ref));
    });

/// A student's visible predicted grades by year — the signed-in student's own or a parent's child.
final studentPredictedGradesProvider = FutureProvider.autoDispose
    .family<List<PredictedGradesYear>, String>((ref, studentId) {
      return ref.watch(studentPredictedGradesClientProvider).fetch(studentId);
    });
