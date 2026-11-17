import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'crash_reporter.dart';
import 'monitoring_config.dart';
import 'pii_scrubber.dart';

/// Wires the app to Sentry: crash/error capture, release health (crash-free sessions), and
/// PII-scrubbed breadcrumbs/events.
class SentryCrashReporter implements CrashReporter {
  SentryCrashReporter(this._config, {this._scrubber = const PiiScrubber()});

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
      options.beforeSend = (event, hint) async => scrubEvent(event);
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

  // Sentry 9+ events and breadcrumbs are mutable (copyWith is gone): scrub them in place before
  // they leave the device.
  @visibleForTesting
  //
  // QA-088: free text is scrubbed as well as `extra`. Exception values carry the failing URL (Dio
  // puts it in the message, invitation token included), and the message, request and tags can
  // carry emails and tokens.
  @visibleForTesting
  SentryEvent scrubEvent(SentryEvent event) {
    final user = event.user;
    // ignore: deprecated_member_use -- `extra` is still sent; scrubbing it is the point.
    event.extra = _scrubber.scrubMap(event.extra);
    event.user = user == null ? null : SentryUser(id: user.id);

    for (final exception in event.exceptions ?? const <SentryException>[]) {
      final value = exception.value;
      if (value != null) exception.value = _scrubber.scrubText(value);
    }
    final message = event.message;
    if (message != null) {
      message.formatted = _scrubber.scrubText(message.formatted);
      final template = message.template;
      if (template != null) message.template = _scrubber.scrubText(template);
      message.params = message.params
          ?.map((param) => param is String ? _scrubber.scrubText(param) : param)
          .toList();
    }
    final request = event.request;
    if (request != null) {
      final url = request.url;
      if (url != null) request.url = _scrubber.scrubText(url);
      final query = request.queryString;
      if (query != null) request.queryString = _scrubber.scrubText(query);
      request.headers = _scrubber
          .scrubMap(request.headers)!
          .map((key, value) => MapEntry(key, value! as String));
    }
    final tags = event.tags;
    if (tags != null) {
      event.tags = tags.map((key, value) => MapEntry(key, _scrubber.scrubText(value)));
    }
    return event;
  }

  Breadcrumb _scrubBreadcrumb(Breadcrumb breadcrumb) {
    final message = breadcrumb.message;
    breadcrumb.message = message == null ? null : _scrubber.scrubText(message);
    breadcrumb.data = _scrubber.scrubMap(breadcrumb.data);
    return breadcrumb;
  }
}
