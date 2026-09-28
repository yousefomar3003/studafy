import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/ai_hub_client.dart';
import '../domain/ai_hub_status.dart';

/// [AiHubClient] on its own [Dio], wired identically to `askAiClientProvider` /
/// `aiStudyClientProvider` — same base URL, same bearer-token injection, same
/// [ErrorMappingInterceptor] — standing alone because the `AI` tag is excluded from the generated
/// client (see `pubspec.yaml`), so there is no `api.ai` to hang this read off.
final aiHubClientProvider = Provider<AiHubClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AiHubClient(dio);
});

/// The AI tab's top-level state: calls `GET /api/ai/usage` and maps its outcome onto
/// [AiHubStatus] — `200` -> [AiHubSubscribed], `402 AI_SUBSCRIPTION_INACTIVE` ->
/// [AiHubUnsubscribed], `403 AI_SCHOOL_INACTIVE` -> [AiHubSchoolInactive]. Every other failure
/// (network error, `503 AI_QUOTA_UNAVAILABLE`, …) is left to rethrow into [AsyncError] — a
/// transient fetch failure, not a state this screen has a dedicated message for, so it gets the
/// same retry treatment as any other failed load (see `AiHubScreen`'s `RefreshIndicator`).
///
/// Unlike most student-scoped reads in this app, `GET /api/ai/usage` takes no studentId — it
/// resolves the caller's own AI entitlement from the session's auth context server-side
/// (`usage-routes.ts`) — so this provider does not gate on `currentStudentIdProvider` the way
/// `todayGradesProvider` does.
///
/// `.autoDispose`, not kept alive: [AiHubScreen] re-reads it on every app resume (see that
/// screen's `WidgetsBindingObserver`) so an add-on activated outside the app is reflected without
/// the student having to force-quit and reopen the app.
final aiHubStatusProvider = FutureProvider.autoDispose<AiHubStatus>((ref) async {
  final client = ref.watch(aiHubClientProvider);

  try {
    return AiHubSubscribed(await client.usage());
  } on DioException catch (error) {
    final status = aiHubStatusFromErrorCode(error.apiError?.code);
    if (status == null) rethrow;
    return status;
  }
});
