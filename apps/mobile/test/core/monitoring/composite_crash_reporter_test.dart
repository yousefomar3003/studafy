import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/monitoring/composite_crash_reporter.dart';

import '../../support/fake_crash_reporter.dart';

void main() {
  group('fan-out', () {
    test('initialize initializes every reporter', () async {
      final a = FakeCrashReporter();
      final b = FakeCrashReporter();

      await CompositeCrashReporter([a, b]).initialize();

      expect(a.initialized, isTrue);
      expect(b.initialized, isTrue);
    });

    test('identifyUser reaches every reporter', () {
      final a = FakeCrashReporter();
      final b = FakeCrashReporter();

      CompositeCrashReporter([a, b]).identifyUser('user-42');

      expect(a.identifiedUserId, 'user-42');
      expect(b.identifiedUserId, 'user-42');
    });

    test('recordError reaches every reporter with the same error', () async {
      final a = FakeCrashReporter();
      final b = FakeCrashReporter();
      final error = StateError('boom');
      final stackTrace = StackTrace.current;

      await CompositeCrashReporter([a, b]).recordError(error, stackTrace, fatal: true);

      expect(a.errors.single.error, same(error));
      expect(a.errors.single.fatal, isTrue);
      expect(b.errors.single.error, same(error));
      expect(b.errors.single.fatal, isTrue);
    });

    test('recordFlutterError reaches every reporter', () async {
      final a = FakeCrashReporter();
      final b = FakeCrashReporter();
      final details = FlutterErrorDetails(exception: StateError('boom'));

      await CompositeCrashReporter([a, b]).recordFlutterError(details);

      expect(a.flutterErrors.single, same(details));
      expect(b.flutterErrors.single, same(details));
    });
  });

  group('PII scrubbing at the fan-out boundary', () {
    test('addBreadcrumb scrubs the message and data before reaching reporters', () {
      final reporter = FakeCrashReporter();

      CompositeCrashReporter([reporter]).addBreadcrumb(
        'contacted parent.one@example.com',
        data: {'authorization': 'Bearer abc123', 'route': '/materials'},
      );

      final crumb = reporter.breadcrumbs.single;
      expect(crumb.message, 'contacted [redacted-email]');
      expect(crumb.data, {'authorization': '[redacted]', 'route': '/materials'});
    });

    test('recordError scrubs the reason before reaching reporters', () async {
      final reporter = FakeCrashReporter();

      await CompositeCrashReporter([reporter]).recordError(
        StateError('boom'),
        StackTrace.current,
        reason: 'reported by student.two@example.com',
      );

      expect(reporter.errors.single.reason, 'reported by [redacted-email]');
    });
  });

  group('backend isolation', () {
    test('one reporter throwing during initialize does not stop the others', () async {
      final broken = FakeCrashReporter()..throwOnCall = StateError('vendor SDK unavailable');
      final healthy = FakeCrashReporter();

      await CompositeCrashReporter([broken, healthy]).initialize();

      expect(healthy.initialized, isTrue);
    });

    test('one reporter throwing during recordError does not stop the others or propagate', () async {
      final broken = FakeCrashReporter()..throwOnCall = StateError('vendor SDK unavailable');
      final healthy = FakeCrashReporter();

      await CompositeCrashReporter(
        [broken, healthy],
      ).recordError(StateError('boom'), StackTrace.current);

      expect(healthy.errors, hasLength(1));
    });

    test('one reporter throwing synchronously from identifyUser does not stop the others', () {
      final broken = FakeCrashReporter()..throwOnCall = StateError('vendor SDK unavailable');
      final healthy = FakeCrashReporter();

      CompositeCrashReporter([broken, healthy]).identifyUser('user-1');

      expect(healthy.identifiedUserId, 'user-1');
    });
  });
}
