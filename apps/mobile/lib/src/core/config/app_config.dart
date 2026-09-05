import 'app_environment.dart';

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.realtimeBaseUrl,
    required this.webBaseUrl,
    required this.aiAddonPriceId,
  });

  factory AppConfig.fromEnvironment(AppEnvironment environment) {
    const apiBaseUrlOverride = String.fromEnvironment('API_BASE_URL');
    const realtimeBaseUrlOverride = String.fromEnvironment('REALTIME_BASE_URL');
    const webBaseUrlOverride = String.fromEnvironment('WEB_BASE_URL');

    return AppConfig(
      environment: environment,
      apiBaseUrl: Uri.parse(
        apiBaseUrlOverride.isEmpty
            ? environment.defaultApiBaseUrl
            : apiBaseUrlOverride,
      ),
      realtimeBaseUrl: Uri.parse(
        realtimeBaseUrlOverride.isEmpty
            ? environment.defaultRealtimeBaseUrl
            : realtimeBaseUrlOverride,
      ),
      webBaseUrl: Uri.parse(
        webBaseUrlOverride.isEmpty ? environment.defaultWebBaseUrl : webBaseUrlOverride,
      ),
      // The Stripe-synced `plan_prices` row id backing the AI add-on (see apps/api's
      // `createAiCheckoutSession` and `apps/mobile/docs/ai_store_compliance.md` for why mobile
      // carries a priceId at all) is a real database row, not a deployment convention like the
      // URLs above, so no environment has a hardcodable default. An unset `AI_ADDON_PRICE_ID`
      // build-time define resolves to empty — `buildAiCheckoutUrl`
      // (features/ai/domain/ai_checkout_link.dart) treats that as "checkout not configured for
      // this build" rather than emitting a link the destination page would reject.
      aiAddonPriceId: const String.fromEnvironment('AI_ADDON_PRICE_ID'),
    );
  }

  final AppEnvironment environment;
  final Uri apiBaseUrl;
  final Uri realtimeBaseUrl;
  final Uri webBaseUrl;

  /// The `plan_prices.id` (Stripe-synced) for the AI add-on's one price, injected per environment
  /// via `--dart-define=AI_ADDON_PRICE_ID=...`. Empty when unset.
  final String aiAddonPriceId;

  /// Used by `integration_test/support/test_app.dart` to repoint [apiBaseUrl] at an unroutable
  /// host mid-test (the attendance-offline-replay journey's "airplane mode") via
  /// `ProviderContainer.updateOverrides` — see that file for why a real OS-level network toggle
  /// isn't available to an instrumented test.
  AppConfig copyWith({Uri? apiBaseUrl}) {
    return AppConfig(
      environment: environment,
      apiBaseUrl: apiBaseUrl ?? this.apiBaseUrl,
      realtimeBaseUrl: realtimeBaseUrl,
      webBaseUrl: webBaseUrl,
      aiAddonPriceId: aiAddonPriceId,
    );
  }
}
