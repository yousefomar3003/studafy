import 'package:flutter/foundation.dart';

import 'app_environment.dart';

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.realtimeBaseUrl,
    required this.webBaseUrl,
    this.realtimeEnabled = false,
  });

  factory AppConfig.fromEnvironment(AppEnvironment environment) {
    const apiBaseUrlOverride = String.fromEnvironment('API_BASE_URL');
    const realtimeBaseUrlOverride = String.fromEnvironment('REALTIME_BASE_URL');
    const webBaseUrlOverride = String.fromEnvironment('WEB_BASE_URL');
    // Live updates are deferred (the gateway's cost was not worth it yet), so no build opens the
    // realtime socket unless it is built with `--dart-define=REALTIME_ENABLED=true`. Without it the
    // app never asks for a ticket or dials the gateway, and so never wakes the scaled-to-zero
    // realtime app (infra/fly/realtime.toml); screens load fresh data when opened as before.
    const realtimeEnabled = bool.fromEnvironment('REALTIME_ENABLED');

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
      realtimeEnabled: realtimeEnabled,
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

  /// Whether the app connects to the realtime gateway at all (`REALTIME_ENABLED`, off by default).
  final bool realtimeEnabled;

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
      realtimeEnabled: realtimeEnabled,
    );
  }
}
