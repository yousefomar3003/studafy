import 'package:flutter_test/flutter_test.dart';
import 'package:sentry_flutter/sentry_flutter.dart';
import 'package:studafy_mobile/src/core/monitoring/monitoring_config.dart';
import 'package:studafy_mobile/src/core/monitoring/sentry_reporter.dart';

/// QA-088: `beforeSend` scrubbed only `extra` and the user. An exception's message (where Dio puts
/// the failing URL, invitation token included), the event message, the request URL and query, and
/// tags all reached Sentry as they were.
void main() {
  const token = 'k3Y9xQ2vT7mN4pL8wR1sZ6aB0cD5eF';
  final reporter = SentryCrashReporter(
    const MonitoringConfig(sentryDsn: 'https://k@o.ingest.sentry.io/1', environment: 'test', release: 'r'),
  );

  test('scrubs exception values, the message, the request and tags', () {
    final event = SentryEvent(
      message: SentryMessage('sign-in failed for parent@example.com'),
      exceptions: [
        SentryException(
          type: 'DioException',
          value:
              'POST https://api.studafy.com/api/auth/invitations/$token/oauth/google/mobile-exchange '
              'for parent@example.com',
        ),
      ],
      request: SentryRequest(
        url: 'https://api.studafy.com/api/auth/invitations/$token/oauth/google/mobile-start',
        queryString: 'code=c0de&state=s7&page=2',
        headers: {'Authorization': 'Bearer $token', 'Accept': 'application/json'},
      ),
      tags: {'route': '/activate?token=$token'},
      user: SentryUser(id: 'u1', email: 'parent@example.com', ipAddress: '10.0.0.1'),
    );

    final scrubbed = reporter.scrubEvent(event);

    expect(scrubbed.message!.formatted, 'sign-in failed for [redacted-email]');
    final value = scrubbed.exceptions!.single.value!;
    expect(value, isNot(contains(token)));
    expect(value, contains('/invitations/[redacted]/oauth/google'));
    expect(value, contains('[redacted-email]'));
    expect(scrubbed.exceptions!.single.type, 'DioException');
    expect(scrubbed.request!.url, isNot(contains(token)));
    expect(scrubbed.request!.queryString, 'code=[redacted]&state=[redacted]&page=2');
    expect(scrubbed.request!.headers['Authorization'], '[redacted]');
    expect(scrubbed.request!.headers['Accept'], 'application/json');
    expect(scrubbed.tags!['route'], '/activate?token=[redacted]');
    expect(scrubbed.user!.id, 'u1');
    expect(scrubbed.user!.email, isNull);
    expect(scrubbed.user!.ipAddress, isNull);
  });

  test('an event with nothing to scrub passes through', () {
    final event = SentryEvent(exceptions: [SentryException(type: 'StateError', value: 'Bad state: no element')]);
    expect(reporter.scrubEvent(event).exceptions!.single.value, 'Bad state: no element');
  });
}
