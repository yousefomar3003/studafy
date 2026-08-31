import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/ask_ai_client.dart';

/// [AskAiClient] on its own [Dio], wired identically to `createApiClient` — same base URL, same
/// bearer-token injection, same [ErrorMappingInterceptor] — but standing alone because the
/// generated client's `Dio` isn't reachable and the streaming call needs per-request options
/// anyway. Same shape as `storageDownloadClientProvider`.
final askAiClientProvider = Provider<AskAiClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AskAiClient(dio);
});

/// The `{studentId}` the Ask AI routes take is the signed-in student's **user id**, not a
/// `StudentProfile` id: `report-routes.ts` rejects any call where `auth.userId != studentId`
/// with 403, and `app.ai_subscriptions.student_id` is keyed by user id. So — unlike
/// `currentStudentIdProvider`, which has no resolution path and stays null — this seam is just
/// the session subject (`sub` claim).
///
/// Null only when the session holds no token; the screen renders its signed-out state then.
/// Overridable in tests the same way as the other student-context seams.
final askAiStudentIdProvider = Provider<String?>((ref) {
  // authSessionProvider hands back a long-lived mutable object; authStatusProvider is what
  // actually changes on login/logout, so watch it to rebuild.
  ref.watch(authStatusProvider);
  return ref.watch(authSessionProvider).userId;
});
