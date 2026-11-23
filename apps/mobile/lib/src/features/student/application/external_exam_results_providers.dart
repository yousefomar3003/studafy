import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/external_exam_results_client.dart';
import '../domain/external_exam_results.dart';

/// [ExternalExamResultsClient] on its own [authenticatedDio], like `transcriptClientProvider`.
final externalExamResultsClientProvider = Provider<ExternalExamResultsClient>((
  ref,
) {
  return ExternalExamResultsClient(authenticatedDio(ref));
});

/// A student's test scores, newest sitting first — the signed-in student's own or a parent's
/// child.
final studentExternalExamResultsProvider = FutureProvider.autoDispose
    .family<List<ExternalExamResult>, String>((ref, studentId) {
      return ref
          .watch(externalExamResultsClientProvider)
          .fetchResults(studentId);
    });
