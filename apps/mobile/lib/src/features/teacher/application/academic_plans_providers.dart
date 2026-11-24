import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/academic_plans_client.dart';
import '../domain/academic_plans.dart';

final academicPlansClientProvider = Provider<AcademicPlansClient>((ref) {
  return AcademicPlansClient(authenticatedDio(ref));
});

/// A section, one of its subjects, and a period (null term = the whole year).
typedef SectionSubjectPeriod = ({
  String sectionId,
  String subjectId,
  String? termId,
});

final outcomeAchievementsProvider = FutureProvider.autoDispose
    .family<SectionOutcomeAchievements, SectionSubjectPeriod>((ref, key) {
      return ref
          .watch(academicPlansClientProvider)
          .fetchAchievements(key.sectionId, key.subjectId, termId: key.termId);
    });

typedef SectionSubjectPlans = ({
  PlanKind kind,
  String sectionId,
  String subjectId,
});

final sectionPlansProvider = FutureProvider.autoDispose
    .family<List<PlanSummary>, SectionSubjectPlans>((ref, key) {
      return ref
          .watch(academicPlansClientProvider)
          .listPlans(key.kind, key.sectionId, key.subjectId);
    });

final termPlanProvider = FutureProvider.autoDispose.family<TermPlan, String>((
  ref,
  planId,
) {
  return ref.watch(academicPlansClientProvider).fetchTermPlan(planId);
});

final lessonPlanProvider = FutureProvider.autoDispose
    .family<LessonPlan, String>((ref, planId) {
      return ref.watch(academicPlansClientProvider).fetchLessonPlan(planId);
    });

typedef LessonOptionsKey = ({String sectionId, String subjectId, String? date});

final lessonPlanOptionsProvider = FutureProvider.autoDispose
    .family<LessonPlanOptions, LessonOptionsKey>((ref, key) {
      return ref
          .watch(academicPlansClientProvider)
          .lessonOptions(key.sectionId, key.subjectId, date: key.date);
    });

/// The plans awaiting the signed-in user's review (empty for a teacher who coordinates nothing).
final planReviewQueueProvider = FutureProvider.autoDispose<PlanReviewQueue>((
  ref,
) {
  return ref.watch(academicPlansClientProvider).reviewQueue();
});
