import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

import 'crash_reporter.dart';
import 'pii_scrubber.dart';

/// Wires the app to Firebase Crashlytics.
///
/// Crashlytics has no `beforeSend`/`beforeBreadcrumb` hook of its own — unlike
/// [SentryCrashReporter], everything it receives here is already scrubbed by whichever caller
/// is feeding it (normally [CompositeCrashReporter]), plus a defensive [PiiScrubber] pass on the
/// free-text fields this class controls directly ([addBreadcrumb]'s message, [recordError]'s
/// reason).
class FirebaseCrashlyticsReporter implements CrashReporter {
  FirebaseCrashlyticsReporter({PiiScrubber scrubber = const PiiScrubber()}) : _scrubber = scrubber;

  final PiiScrubber _scrubber;

  FirebaseCrashlytics get _crashlytics => FirebaseCrashlytics.instance;

  @override
  Future<void> initialize() => _crashlytics.setCrashlyticsCollectionEnabled(true);

  @override
  void identifyUser(String? userId) {
    _crashlytics.setUserIdentifier(userId ?? '');
  }

  @override
  void addBreadcrumb(String message, {String category = 'app', Map<String, Object?>? data}) {
    _crashlytics.log('[$category] ${_scrubber.scrubText(message)}');
  }

  @override
  Future<void> recordError(
    Object error,
    StackTrace stackTrace, {
    bool fatal = false,
    String? reason,
  }) {
    return _crashlytics.recordError(
      error,
      stackTrace,
      reason: reason == null ? null : _scrubber.scrubText(reason),
      fatal: fatal,
    );
  }

  @override
  Future<void> recordFlutterError(FlutterErrorDetails details) {
    return _crashlytics.recordFlutterFatalError(details);
  }
}
