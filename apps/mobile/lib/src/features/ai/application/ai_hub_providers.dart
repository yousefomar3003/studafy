import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_client.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/config/app_config.dart';
import '../../../core/di/app_providers.dart';
import '../../student/application/student_context_providers.dart';
import '../domain/ai_checkout_link.dart';
import '../domain/ai_hub_status.dart';
import '../domain/ai_usage.dart';

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
/// `todayGradesProvider` does. That gap only blocks the checkout link below, not this read.
///
/// `.autoDispose`, not kept alive: [AiHubScreen] re-reads it on every app resume (see that
/// screen's `WidgetsBindingObserver`) so a checkout finished in the external browser is reflected
/// without the student having to force-quit and reopen the app.
final aiHubStatusProvider = FutureProvider.autoDispose<AiHubStatus>((ref) async {
  final api = ref.watch(apiClientProvider);

  try {
    final usage = await api.ai.getAiUsage();
    return AiHubSubscribed(
      AiUsage(
        budget: usage.budget,
        usedTokens: usage.usedTokens,
        heldTokens: usage.heldTokens,
        remaining: usage.remaining,
        periodEnd: usage.periodEnd,
      ),
    );
  } on DioException catch (error) {
    final status = aiHubStatusFromErrorCode(error.apiError?.code);
    if (status == null) rethrow;
    return status;
  }
});

/// The external-browser checkout link for the AI add-on, or `null` when either input it needs
/// isn't available yet — see [buildAiCheckoutUrl]'s doc comment for the two reasons that happens.
/// [AiHubScreen]'s upsell state disables its "Continue on the website" action while this is null
/// rather than launching a link the destination page would reject.
final aiCheckoutUrlProvider = Provider.autoDispose<Uri?>((ref) {
  final config = ref.watch(appConfigProvider);
  final studentId = ref.watch(currentStudentIdProvider);

  return buildAiCheckoutUrl(
    webBaseUrl: config.webBaseUrl,
    studentId: studentId,
    aiAddonPriceId: config.aiAddonPriceId,
  );
});
