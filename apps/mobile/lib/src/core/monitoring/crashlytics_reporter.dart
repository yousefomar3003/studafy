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
  /// [crashlytics] is for tests; the app uses [FirebaseCrashlytics.instance].
  FirebaseCrashlyticsReporter({
    this._scrubber = const PiiScrubber(),
    FirebaseCrashlytics Function()? crashlytics,
  }) : _instance = crashlytics ?? (() => FirebaseCrashlytics.instance);

  final PiiScrubber _scrubber;
  final FirebaseCrashlytics Function() _instance;

  // Crashlytics is gated on Firebase being initialized, which happens post-first-frame (deferred
  // init, see app_bootstrap.dart). Until then `FirebaseCrashlytics.instance` throws, and the first
  // frame's `identifyUser` (monitoring_providers.dart) would otherwise trip on it. Every call is
  // a no-op until [initialize] has set this.
  bool _initialized = false;

  FirebaseCrashlytics get _crashlytics => _instance();

  @override
  Future<void> initialize() async {
    await _crashlytics.setCrashlyticsCollectionEnabled(true);
    _initialized = true;
  }

  @override
  void identifyUser(String? userId) {
    if (!_initialized) return;
    _crashlytics.setUserIdentifier(userId ?? '');
  }

  @override
  void addBreadcrumb(String message, {String category = 'app', Map<String, Object?>? data}) {
    if (!_initialized) return;
    _crashlytics.log('[$category] ${_scrubber.scrubText(message)}');
  }

  @override
  Future<void> recordError(
    Object error,
    StackTrace stackTrace, {
    bool fatal = false,
    String? reason,
  }) {
    if (!_initialized) return Future.value();
    // Crashlytics sends `error.toString()` as the exception message, so the scrubbed text is
    // passed in its place (QA-088): a Dio error's message carries the failing URL.
    return _crashlytics.recordError(
      _scrubber.scrubText(error.toString()),
      stackTrace,
      reason: reason == null ? null : _scrubber.scrubText(reason),
      fatal: fatal,
    );
  }

  /// What `FirebaseCrashlytics.recordFlutterFatalError` sends, scrubbed: the exception text, the
  /// context and the framework's extra information. The error was already printed by
  /// `FlutterError.onError` (app_bootstrap.dart), so it isn't printed again.
  @override
  Future<void> recordFlutterError(FlutterErrorDetails details) {
    if (!_initialized) return Future.value();
    final context = details.context?.toStringDeep(minLevel: DiagnosticLevel.info).trim();
    final information = details.informationCollector?.call() ?? const <DiagnosticsNode>[];
    return _crashlytics.recordError(
      _scrubber.scrubText(details.exceptionAsString()),
      details.stack,
      reason: context == null ? null : _scrubber.scrubText(context),
      information: [for (final node in information) _scrubber.scrubText(node.toString())],
      printDetails: false,
      fatal: true,
    );
  }
}
