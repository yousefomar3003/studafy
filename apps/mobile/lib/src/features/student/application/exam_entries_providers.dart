import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/exam_entries_client.dart';
import '../domain/exam_entries.dart';

/// [ExamEntriesClient] on its own [authenticatedDio], like `externalExamResultsClientProvider`.
final examEntriesClientProvider = Provider<ExamEntriesClient>((ref) {
  return ExamEntriesClient(authenticatedDio(ref));
});

/// A student's exam entries, latest session first — the signed-in student's own or a parent's
/// child.
final studentExamEntriesProvider = FutureProvider.autoDispose
    .family<List<StudentExamEntry>, String>((ref, studentId) {
      return ref.watch(examEntriesClientProvider).fetchEntries(studentId);
    });
