import 'package:flutter/foundation.dart';

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
            ? _hostLoopback(environment.defaultApiBaseUrl)
            : apiBaseUrlOverride,
      ),
      realtimeBaseUrl: Uri.parse(
        realtimeBaseUrlOverride.isEmpty
            ? _hostLoopback(environment.defaultRealtimeBaseUrl)
            : realtimeBaseUrlOverride,
      ),
      webBaseUrl: Uri.parse(
        webBaseUrlOverride.isEmpty ? environment.defaultWebBaseUrl : webBaseUrlOverride,
      ),
    );
  }

  /// The dev defaults use `10.0.2.2`, the Android emulator's alias for the host machine. The iOS
  /// simulator shares the host's network stack, so there the same services are on `localhost`.
  static String _hostLoopback(String url) =>
      !kIsWeb && defaultTargetPlatform != TargetPlatform.android
          ? url.replaceFirst('//10.0.2.2:', '//localhost:')
          : url;

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
