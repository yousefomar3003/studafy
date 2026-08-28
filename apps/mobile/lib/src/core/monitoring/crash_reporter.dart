import 'package:flutter/foundation.dart';

/// A crash/error reporting backend.
///
/// One implementation per vendor ([SentryCrashReporter], [FirebaseCrashlyticsReporter]); app
/// code never talks to either vendor directly — it goes through [CompositeCrashReporter] (bound
/// to `crashReporterProvider`), which fans calls out to both and scrubs PII along the way. That
/// seam is what keeps Sentry/Crashlytics types out of the rest of the app and makes the fan-out
/// and scrubbing independently testable with a fake.
abstract class CrashReporter {
  /// Performs vendor SDK setup. Called once, during bootstrap, before [runApp].
  Future<void> initialize();

  /// Attaches the given user id to subsequent reports, or clears it when null.
  ///
  /// Always an opaque id — never an email, name, or other PII. Callers that only have a JWT
  /// should pass its `sub` claim (see `AuthSession.userId`).
  void identifyUser(String? userId);

  /// Records a breadcrumb: a timestamped trail entry shown alongside the next crash report.
  /// Best-effort — a breadcrumb failing to record must never surface as an app error.
  void addBreadcrumb(String message, {String category = 'app', Map<String, Object?>? data});

  /// Reports a caught error. [fatal] marks it as having crashed (or would have crashed) the app.
  Future<void> recordError(
    Object error,
    StackTrace stackTrace, {
    bool fatal = false,
    String? reason,
  });

  /// Reports an error the Flutter framework itself caught (widget build/layout/paint errors).
  Future<void> recordFlutterError(FlutterErrorDetails details);
}

/// Throws a real, uncaught exception for manually verifying the monitoring pipeline end to end.
///
/// Not part of [CrashReporter]: a test crash is just an exception the app didn't catch, so the
/// global hooks `bootstrapApp` already installs (`FlutterError.onError`,
/// `PlatformDispatcher.instance.onError`, `runZonedGuarded`) are what carry it to both vendors —
/// exactly the path a real crash takes. Wire this to a temporary debug affordance (a button, a
/// DevTools eval) to confirm a report appears, symbolicated, in both dashboards; see
/// `docs/monitoring.md`.
Never triggerTestCrash() {
  throw StateError(
    'Studafy monitoring test crash — verify this appears in both the Sentry and '
    'Crashlytics dashboards, then remove the affordance that called this.',
  );
}
