import 'app_environment.dart';

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.realtimeBaseUrl,
  });

  factory AppConfig.fromEnvironment(AppEnvironment environment) {
    const apiBaseUrlOverride = String.fromEnvironment('API_BASE_URL');
    const realtimeBaseUrlOverride = String.fromEnvironment('REALTIME_BASE_URL');

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
    );
  }

  final AppEnvironment environment;
  final Uri apiBaseUrl;
  final Uri realtimeBaseUrl;
}
