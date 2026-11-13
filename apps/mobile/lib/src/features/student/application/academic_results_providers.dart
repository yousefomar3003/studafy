import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/academic_results_client.dart';
import '../domain/academic_results.dart';

/// [AcademicResultsClient] on its own [authenticatedDio] — the `gradeEntryClientProvider`
/// pattern for a surface served by a hand-written client.
final academicResultsClientProvider = Provider<AcademicResultsClient>((ref) {
  return AcademicResultsClient(authenticatedDio(ref));
});

/// A student's finalized results, keyed by student id — the signed-in student's own
/// (`currentStudentIdProvider`) or a parent's selected child.
final studentResultsProvider = FutureProvider.autoDispose
    .family<List<FinalizedResult>, String>((ref, studentId) {
      return ref.watch(academicResultsClientProvider).fetchResults(studentId);
    });

/// A student's certificates and report cards, newest first.
final studentCertificatesProvider = FutureProvider.autoDispose
    .family<List<AcademicCertificate>, String>((ref, studentId) async {
      final certificates = await ref
          .watch(academicResultsClientProvider)
          .fetchCertificates(studentId);
      return certificates..sort((a, b) {
        final aTime = a.issuedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
        final bTime = b.issuedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
        return bTime.compareTo(aTime);
      });
    });

/// One certificate or report card exactly as issued.
final academicCertificateProvider = FutureProvider.autoDispose
    .family<AcademicCertificate, String>((ref, certificateId) {
      return ref
          .watch(academicResultsClientProvider)
          .fetchCertificate(certificateId);
    });
