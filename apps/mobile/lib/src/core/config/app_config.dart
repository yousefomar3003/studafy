import 'app_environment.dart';

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.realtimeBaseUrl,
    required this.webBaseUrl,
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
    );
  }

  final AppEnvironment environment;
  final Uri apiBaseUrl;
  final Uri realtimeBaseUrl;
  final Uri webBaseUrl;

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
    );
  }
}
