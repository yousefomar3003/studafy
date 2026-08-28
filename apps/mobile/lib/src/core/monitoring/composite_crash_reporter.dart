import 'package:flutter/foundation.dart';

import 'crash_reporter.dart';
import 'pii_scrubber.dart';

/// Fans every [CrashReporter] call out to a fixed set of backends (Sentry, Crashlytics), scrubbing
/// PII once at the boundary so neither backend implementation has to.
///
/// A backend throwing must never (a) stop the other backend from receiving the report, or (b)
/// propagate out of a crash-reporting call — that call is frequently made from inside
/// `FlutterError.onError` or a zone's error handler, contexts where an escaping exception would
/// itself go unhandled. Every fan-out point below is wrapped accordingly.
class CompositeCrashReporter implements CrashReporter {
  CompositeCrashReporter(this._reporters, {PiiScrubber scrubber = const PiiScrubber()})
      : _scrubber = scrubber;

  final List<CrashReporter> _reporters;
  final PiiScrubber _scrubber;

  @override
  Future<void> initialize() async {
    for (final reporter in _reporters) {
      await _guard(reporter.initialize);
    }
  }

  @override
  void identifyUser(String? userId) {
    for (final reporter in _reporters) {
      try {
        reporter.identifyUser(userId);
      } catch (_) {
        // Best-effort — see class doc.
      }
    }
  }

  @override
  void addBreadcrumb(String message, {String category = 'app', Map<String, Object?>? data}) {
    final scrubbedMessage = _scrubber.scrubText(message);
    final scrubbedData = _scrubber.scrubMap(data);
    for (final reporter in _reporters) {
      try {
        reporter.addBreadcrumb(scrubbedMessage, category: category, data: scrubbedData);
      } catch (_) {
        // Best-effort — see class doc.
      }
    }
  }

  @override
  Future<void> recordError(
    Object error,
    StackTrace stackTrace, {
    bool fatal = false,
    String? reason,
  }) async {
    final scrubbedReason = reason == null ? null : _scrubber.scrubText(reason);
    for (final reporter in _reporters) {
      await _guard(
        () => reporter.recordError(error, stackTrace, fatal: fatal, reason: scrubbedReason),
      );
    }
  }

  @override
  Future<void> recordFlutterError(FlutterErrorDetails details) async {
    for (final reporter in _reporters) {
      await _guard(() => reporter.recordFlutterError(details));
    }
  }

  /// Runs [action], swallowing anything it throws — synchronously or via its Future — so one
  /// backend's failure can't stop the loop or escape into the caller's error-handling context.
  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (_) {
      // Best-effort — see class doc.
    }
  }
}
