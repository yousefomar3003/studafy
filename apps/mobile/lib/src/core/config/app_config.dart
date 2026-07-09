import 'app_environment.dart';

class AppConfig {
  const AppConfig({required this.environment, required this.apiBaseUrl});

  factory AppConfig.fromEnvironment(AppEnvironment environment) {
    const apiBaseUrlOverride = String.fromEnvironment('API_BASE_URL');

    return AppConfig(
      environment: environment,
      apiBaseUrl: Uri.parse(
        apiBaseUrlOverride.isEmpty
            ? environment.defaultApiBaseUrl
            : apiBaseUrlOverride,
      ),
    );
  }

  final AppEnvironment environment;
  final Uri apiBaseUrl;
}
