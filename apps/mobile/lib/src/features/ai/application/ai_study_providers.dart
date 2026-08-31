import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/ai_study_client.dart';
import '../domain/ai_study.dart';
import 'ask_ai_providers.dart';

/// [AiStudyClient] on its own [Dio], wired identically to `askAiClientProvider` — same base URL,
/// same bearer-token injection, same [ErrorMappingInterceptor]. Standing alone for the same
/// reason: the generated client's `Dio` isn't reachable and the `AI` tag is excluded from codegen
/// (see `pubspec.yaml`).
final aiStudyClientProvider = Provider<AiStudyClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AiStudyClient(dio);
});

/// The signed-in student's AI quota for the current billing period, feeding the quota meter under
/// both study screens. Invalidated after a fresh (non-cached) generation so the meter reflects the
/// spend. `autoDispose` — it's only alive while a study screen is.
final aiUsageProvider = FutureProvider.autoDispose<AiUsage>((ref) {
  return ref.watch(aiStudyClientProvider).usage();
});

/// The key concepts for one material, keyed by material id. One-shot (no preset), so a plain
/// family provider rather than a controller. Re-fetched on `ref.invalidate`.
///
/// Reuses [askAiStudentIdProvider] — the AI routes' `{studentId}` is the signed-in student's user
/// id, which is exactly that seam. Throws when signed out; the screen guards that path first.
final keyConceptsProvider = FutureProvider.autoDispose.family<List<AiConcept>, String>((
  ref,
  materialId,
) async {
  final studentId = ref.watch(askAiStudentIdProvider);
  if (studentId == null) {
    throw StateError('key concepts requested while signed out');
  }
  final concepts = await ref
      .watch(aiStudyClientProvider)
      .concepts(studentId: studentId, materialId: materialId);
  ref.invalidate(aiUsageProvider);
  return concepts;
});
