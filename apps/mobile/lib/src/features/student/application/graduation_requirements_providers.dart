import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/graduation_requirements_client.dart';
import '../domain/graduation_requirements.dart';

/// [GraduationRequirementsClient] on its own [authenticatedDio], like
/// `externalExamResultsClientProvider`.
final graduationRequirementsClientProvider =
    Provider<GraduationRequirementsClient>((ref) {
      return GraduationRequirementsClient(authenticatedDio(ref));
    });

/// A student's graduation requirements checklist — the signed-in student's own or a parent's
/// child. Empty when no set applies or none is shown to students and parents.
final studentGraduationChecklistProvider = FutureProvider.autoDispose
    .family<List<GraduationSetChecklist>, String>((ref, studentId) {
      return ref
          .watch(graduationRequirementsClientProvider)
          .fetchChecklist(studentId);
    });
