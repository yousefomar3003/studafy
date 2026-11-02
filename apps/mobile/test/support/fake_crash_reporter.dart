import 'package:flutter/foundation.dart';
import 'package:studafy_mobile/src/core/monitoring/crash_reporter.dart';

/// Records every call instead of talking to a real vendor SDK.
///
/// Doubles as the `crashReporterProvider` override for widget tests (via [pumpStudafyApp]) and
/// as a [CompositeCrashReporter] child in that class's own unit tests.
class FakeCrashReporter implements CrashReporter {
  bool initialized = false;
  String? identifiedUserId;
  final breadcrumbs = <FakeBreadcrumb>[];
  final errors = <FakeRecordedError>[];
  final flutterErrors = <FlutterErrorDetails>[];

  /// When set, every method throws this instead of recording — for exercising
  /// [CompositeCrashReporter]'s "one backend failing doesn't stop the others" behavior.
  Object? throwOnCall;

  @override
  Future<void> initialize() async {
    _maybeThrow();
    initialized = true;
  }

  @override
  void identifyUser(String? userId) {
    _maybeThrow();
    identifiedUserId = userId;
  }

  @override
  void addBreadcrumb(String message, {String category = 'app', Map<String, Object?>? data}) {
    _maybeThrow();
    breadcrumbs.add(FakeBreadcrumb(message: message, category: category, data: data));
  }

  @override
  Future<void> recordError(
    Object error,
    StackTrace stackTrace, {
    bool fatal = false,
    String? reason,
  }) async {
    _maybeThrow();
    errors.add(
      FakeRecordedError(error: error, stackTrace: stackTrace, fatal: fatal, reason: reason),
    );
  }

  @override
  Future<void> recordFlutterError(FlutterErrorDetails details) async {
    _maybeThrow();
    flutterErrors.add(details);
  }

  void _maybeThrow() {
    final error = throwOnCall;
    if (error != null) throw error;
  }
}

class FakeBreadcrumb {
  FakeBreadcrumb({required this.message, required this.category, required this.data});

  final String message;
  final String category;
  final Map<String, Object?>? data;
}

class FakeRecordedError {
  FakeRecordedError({
    required this.error,
    required this.stackTrace,
    required this.fatal,
    required this.reason,
  });

  final Object error;
  final StackTrace stackTrace;
  final bool fatal;
  final String? reason;
}
