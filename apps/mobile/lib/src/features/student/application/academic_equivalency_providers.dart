import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/academic_equivalency_client.dart';
import '../domain/academic_equivalency.dart';

/// [AcademicEquivalencyClient] on its own [authenticatedDio], like
/// `graduationRequirementsClientProvider`.
final academicEquivalencyClientProvider = Provider<AcademicEquivalencyClient>((
  ref,
) {
  return AcademicEquivalencyClient(authenticatedDio(ref));
});

/// A student's Tawjihi equivalency estimates — the signed-in student's own or a parent's child.
/// Empty when no rule set applies or none is shown to students and parents.
final studentEquivalencyProvider = FutureProvider.autoDispose
    .family<List<EquivalencyEstimate>, String>((ref, studentId) {
      return ref
          .watch(academicEquivalencyClientProvider)
          .fetchEquivalency(studentId);
    });

/// A student's multi-year results. Empty when no configuration applies or none is shown.
final studentMultiYearResultsProvider = FutureProvider.autoDispose
    .family<List<MultiYearResult>, String>((ref, studentId) {
      return ref
          .watch(academicEquivalencyClientProvider)
          .fetchMultiYearResults(studentId);
    });
