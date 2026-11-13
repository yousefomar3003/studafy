import '../config/app_environment.dart';

/// Configuration for the crash/error reporting backends.
///
/// Mirrors [AppConfig]'s `String.fromEnvironment` override pattern: the DSN has no committed
/// default, so it's supplied per build via `--dart-define=SENTRY_DSN=...` (CI holds the real
/// value per environment; local dev simply omits it).
class MonitoringConfig {
  const MonitoringConfig({
    required this.sentryDsn,
    required this.environment,
    required this.release,
  });

  factory MonitoringConfig.fromEnvironment(
    AppEnvironment environment, {
    required String release,
  }) {
    const dsn = String.fromEnvironment('SENTRY_DSN');

    return MonitoringConfig(
      sentryDsn: dsn,
      environment: environment.shortName,
      release: release,
    );
  }

  final String sentryDsn;
  final String environment;
  final String release;

  /// Sentry only initializes once a DSN is supplied. An empty DSN — the default for local dev —
  /// makes [SentryCrashReporter] a deliberate no-op instead of either crashing on a missing
  /// config value or silently reporting local dev noise into a shared project.
  bool get sentryEnabled => sentryDsn.isNotEmpty;
}
