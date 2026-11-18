import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/monitoring/crashlytics_reporter.dart';

/// Records what would be sent to Crashlytics.
class _FakeCrashlytics implements FirebaseCrashlytics {
  final sent = <({String exception, String? reason, List<String> information, bool fatal})>[];

  @override
  Future<void> setCrashlyticsCollectionEnabled(bool enabled) async {}

  @override
  Future<void> recordError(
    dynamic exception,
    StackTrace? stack, {
    dynamic reason,
    Iterable<Object> information = const [],
    bool? printDetails,
    bool fatal = false,
  }) async {
    sent.add((
      exception: exception.toString(),
      reason: reason?.toString(),
      information: [for (final entry in information) entry.toString()],
      fatal: fatal,
    ));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// QA-088: Crashlytics has no `beforeSend`, and the reporter passed the error object straight
/// through, so its message (a failing URL with an invitation token, an email) reached Firebase.
void main() {
  const token = 'k3Y9xQ2vT7mN4pL8wR1sZ6aB0cD5eF';
  const leaky =
      'POST https://api.studafy.com/api/auth/invitations/$token/oauth/google/mobile-exchange '
      'failed for parent@example.com';

  late _FakeCrashlytics crashlytics;
  late FirebaseCrashlyticsReporter reporter;

  setUp(() async {
    crashlytics = _FakeCrashlytics();
    reporter = FirebaseCrashlyticsReporter(crashlytics: () => crashlytics);
    await reporter.initialize();
  });

  void expectClean(String text) {
    expect(text, isNot(contains(token)));
    expect(text, isNot(contains('parent@example.com')));
  }

  test('recordError scrubs the exception message and the reason', () async {
    await reporter.recordError(Exception(leaky), StackTrace.current, reason: 'while $leaky');

    final sent = crashlytics.sent.single;
    expectClean(sent.exception);
    expectClean(sent.reason!);
    expect(sent.exception, contains('/invitations/[redacted]/'));
    expect(sent.exception, startsWith('Exception: '));
  });

  test('recordFlutterError scrubs the exception, context and information', () async {
    await reporter.recordFlutterError(
      FlutterErrorDetails(
        exception: StateError(leaky),
        stack: StackTrace.current,
        context: ErrorDescription('building $leaky'),
        informationCollector: () => [ErrorDescription('route $leaky')],
      ),
    );

    final sent = crashlytics.sent.single;
    expect(sent.fatal, isTrue);
    expectClean(sent.exception);
    expectClean(sent.reason!);
    for (final line in sent.information) {
      expectClean(line);
    }
  });
}
