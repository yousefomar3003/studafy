import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/ai_consent_client.dart';
import '../domain/ai_consent.dart';

/// [AiConsentClient] on its own [Dio], wired identically to `aiHubClientProvider` — the `AI` tag
/// has no generated client to hang this off (see `pubspec.yaml`).
final aiConsentClientProvider = Provider<AiConsentClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AiConsentClient(dio);
});

/// The signed-in user's AI data-sharing consent (ST-305) — the one source every `AiConsentGate`
/// and the data-sharing screen read, so a grant or withdrawal anywhere relocks or unlocks every
/// AI screen at once.
///
/// Kept alive for the session (it is the gate in front of every AI screen) and rebuilt with it:
/// [aiConsentClientProvider] watches `authSessionProvider`, so a different user never inherits
/// the previous user's answer.
class AiConsentNotifier extends AsyncNotifier<AiConsentStatus> {
  @override
  Future<AiConsentStatus> build() => ref.watch(aiConsentClientProvider).status();

  /// Records consent to the disclosure [version] the user was shown — never a newer one they
  /// haven't seen. Rethrows on failure, leaving the current state in place; when the server
  /// reports that version outdated the disclosure is refetched, so the next prompt shows the new
  /// one.
  Future<void> grant(String version) async {
    try {
      state = AsyncData(await ref.read(aiConsentClientProvider).grant(version));
    } on DioException catch (error) {
      if (isAiConsentDisclosureOutdated(error)) ref.invalidateSelf();
      rethrow;
    }
  }

  /// Withdraws consent. Rethrows on failure, leaving the current state in place.
  Future<void> withdraw() async {
    state = AsyncData(await ref.read(aiConsentClientProvider).withdraw());
  }
}

/// True when a grant was refused because the server now serves a newer disclosure.
bool isAiConsentDisclosureOutdated(Object error) =>
    error is DioException && error.apiError?.code == 'AI_CONSENT_DISCLOSURE_OUTDATED';

final aiConsentProvider = AsyncNotifierProvider<AiConsentNotifier, AiConsentStatus>(
  AiConsentNotifier.new,
);
