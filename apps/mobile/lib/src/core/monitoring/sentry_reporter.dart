import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'crash_reporter.dart';
import 'monitoring_config.dart';
import 'pii_scrubber.dart';

/// Wires the app to Sentry: crash/error capture, release health (crash-free sessions), and
/// PII-scrubbed breadcrumbs/events.
class SentryCrashReporter implements CrashReporter {
  SentryCrashReporter(this._config, {PiiScrubber scrubber = const PiiScrubber()})
      : _scrubber = scrubber;

  final MonitoringConfig _config;
  final PiiScrubber _scrubber;

  @override
  Future<void> initialize() async {
    if (!_config.sentryEnabled) return;

    await SentryFlutter.init((options) {
      options.dsn = _config.sentryDsn;
      options.environment = _config.environment;
      options.release = _config.release;
      // Powers the "crash-free sessions" release-health metric in the Sentry dashboard.
      options.enableAutoSessionTracking = true;
      // Never forward IP address / request headers / cookies automatically — the only user
      // identity this app ever attaches is the id set explicitly via [identifyUser].
      options.sendDefaultPii = false;
      options.attachStacktrace = true;
      options.beforeSend = (event, hint) async => _scrubEvent(event);
      options.beforeBreadcrumb =
          (breadcrumb, hint) => breadcrumb == null ? null : _scrubBreadcrumb(breadcrumb);
    });
  }

  @override
  void identifyUser(String? userId) {
    if (!_config.sentryEnabled) return;
    // configureScope returns FutureOr<void> — nothing to await for a scope mutation this small.
    Sentry.configureScope(
      (scope) => scope.setUser(userId == null ? null : SentryUser(id: userId)),
    );
  }

  @override
  void addBreadcrumb(String message, {String category = 'app', Map<String, Object?>? data}) {
    if (!_config.sentryEnabled) return;
    unawaited(
      Sentry.addBreadcrumb(
        Breadcrumb(
          message: _scrubber.scrubText(message),
          category: category,
          data: _scrubber.scrubMap(data),
        ),
      ),
    );
  }

  @override
  Future<void> recordError(
    Object error,
    StackTrace stackTrace, {
    bool fatal = false,
    String? reason,
  }) async {
    if (!_config.sentryEnabled) return;
    if (reason != null) addBreadcrumb(reason, category: 'error-context');
    await Sentry.captureException(error, stackTrace: stackTrace);
  }

  @override
  Future<void> recordFlutterError(FlutterErrorDetails details) async {
    if (!_config.sentryEnabled) return;
    await Sentry.captureException(details.exception, stackTrace: details.stack);
  }

  SentryEvent _scrubEvent(SentryEvent event) {
    final user = event.user;
    return event.copyWith(
      extra: _scrubber.scrubMap(event.extra),
      user: user == null ? null : SentryUser(id: user.id),
    );
  }

  Breadcrumb _scrubBreadcrumb(Breadcrumb breadcrumb) {
    final message = breadcrumb.message;
    return breadcrumb.copyWith(
      message: message == null ? null : _scrubber.scrubText(message),
      data: _scrubber.scrubMap(breadcrumb.data),
    );
  }
}
