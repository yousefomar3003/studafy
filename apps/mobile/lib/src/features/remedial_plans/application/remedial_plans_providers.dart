import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/remedial_plans_client.dart';
import '../domain/remedial_plan.dart';

/// [RemedialPlansClient] on its own [authenticatedDio], like `predictedGradesClientProvider`.
final remedialPlansClientProvider = Provider<RemedialPlansClient>((ref) {
  return RemedialPlansClient(authenticatedDio(ref));
});

/// A section, one of its subjects, and a period (null term = the whole year).
typedef SectionRemedialKey = ({
  String sectionId,
  String subjectId,
  String? termId,
});

/// A section's subject: plans and suggestions (teachers, coordinators, leadership).
final sectionRemedialPlansProvider = FutureProvider.autoDispose
    .family<SectionRemedialPlans, SectionRemedialKey>((ref, key) {
      return ref
          .watch(remedialPlansClientProvider)
          .fetchSection(key.sectionId, key.subjectId, termId: key.termId);
    });

/// One plan with its reviews and timeline.
final remedialPlanProvider = FutureProvider.autoDispose
    .family<RemedialPlan, String>((ref, planId) {
      return ref.watch(remedialPlansClientProvider).fetchPlan(planId);
    });

/// A student's plans the caller may read — for the student and parents, the shared ones only.
final studentRemedialPlansProvider = FutureProvider.autoDispose
    .family<List<RemedialPlan>, String>((ref, studentId) {
      return ref.watch(remedialPlansClientProvider).fetchStudent(studentId);
    });
