import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/released_marks_client.dart';
import '../domain/released_marks.dart';

/// [ReleasedMarksClient] on its own [authenticatedDio], like `academicResultsClientProvider`.
final releasedMarksClientProvider = Provider<ReleasedMarksClient>((ref) {
  return ReleasedMarksClient(authenticatedDio(ref));
});

/// A student's approved marks, keyed by student id — the signed-in student's own
/// (`currentStudentIdProvider`) or a parent's selected child.
final studentReleasedMarksProvider = FutureProvider.autoDispose
    .family<List<ReleasedMarkPeriod>, String>((ref, studentId) {
      return ref.watch(releasedMarksClientProvider).fetchMarks(studentId);
    });
