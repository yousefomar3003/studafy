import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/monitoring/pii_scrubber.dart';

void main() {
  const scrubber = PiiScrubber();

  group('scrubText', () {
    test('redacts an email address embedded in free text', () {
      expect(
        scrubber.scrubText('Failed to sync for student.parent@example.com, retrying'),
        'Failed to sync for [redacted-email], retrying',
      );
    });

    test('leaves text with no email untouched', () {
      expect(scrubber.scrubText('Failed to sync timetable, retrying'), 'Failed to sync timetable, retrying');
    });
  });

  group('scrubMap', () {
    test('redacts values for sensitive keys, case-insensitively', () {
      final scrubbed = scrubber.scrubMap({
        'Authorization': 'Bearer abc123',
        'password': 'hunter2',
        'refreshToken': 'rt-abc',
        'route': '/timetable',
      });

      expect(scrubbed, {
        'Authorization': '[redacted]',
        'password': '[redacted]',
        'refreshToken': '[redacted]',
        'route': '/timetable',
      });
    });

    test('redacts nested maps and lists recursively', () {
      final scrubbed = scrubber.scrubMap({
        'request': {'headers': {'cookie': 'session=abc'}, 'path': '/api/grades'},
        'notes': ['contact reporter@example.com', 'no pii here'],
      });

      expect(
        scrubbed,
        {
          'request': {
            'headers': {'cookie': '[redacted]'},
            'path': '/api/grades',
          },
          'notes': ['contact [redacted-email]', 'no pii here'],
        },
      );
    });

    test('returns null for null input', () {
      expect(scrubber.scrubMap(null), isNull);
    });

    test('leaves an empty map untouched', () {
      expect(scrubber.scrubMap(const {}), <String, Object?>{});
    });
  });

  // QA-088: exception messages and URLs carry secrets in free text — an invitation token in a
  // request path, a pre-signed URL's signature, a bearer token in a logged header.
  group('scrubText secrets in URLs and exception messages', () {
    const token = 'k3Y9xQ2vT7mN4pL8wR1sZ6aB0cD5eF';

    test('redacts the invitation token path segment', () {
      expect(
        scrubber.scrubText(
          'DioException [bad response]: POST https://api.studafy.com/api/auth/invitations/$token/oauth/google/mobile-exchange 400',
        ),
        'DioException [bad response]: POST https://api.studafy.com/api/auth/invitations/[redacted]/oauth/google/mobile-exchange 400',
      );
    });

    test('redacts a relative invitation path too', () {
      expect(
        scrubber.scrubText('/api/auth/invitations/$token/oauth/google/mobile-start'),
        '/api/auth/invitations/[redacted]/oauth/google/mobile-start',
      );
    });

    test('redacts secret query parameters and keeps the rest', () {
      expect(
        scrubber.scrubText(
          'GET https://storage.test/o/a.pdf?X-Amz-Signature=abc123&X-Amz-Credential=AKIA/x&X-Amz-Expires=300&token=$token&code=c0de&state=s7&page=2',
        ),
        'GET https://storage.test/o/a.pdf?X-Amz-Signature=[redacted]&X-Amz-Credential=[redacted]&X-Amz-Expires=300&token=[redacted]&code=[redacted]&state=[redacted]&page=2',
      );
    });

    test('redacts bearer tokens and JWTs', () {
      expect(
        scrubber.scrubText('headers: {Authorization: Bearer $token}'),
        'headers: {Authorization: Bearer [redacted]}',
      );
      expect(
        scrubber.scrubText('refresh failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'),
        'refresh failed for [redacted-jwt]',
      );
    });

    test('an exception carrying both a token URL and an email loses both', () {
      final error = Exception(
        'activation failed for parent@example.com at /api/auth/invitations/$token/oauth/microsoft/mobile-exchange',
      );
      final scrubbed = scrubber.scrubText(error.toString());
      expect(scrubbed, isNot(contains(token)));
      expect(scrubbed, isNot(contains('parent@example.com')));
      expect(scrubbed, contains('[redacted-email]'));
      expect(scrubbed, contains('/invitations/[redacted]/'));
    });

    test('ordinary paths and text are untouched', () {
      const text = 'GET /api/classes/9f1c2e/students?page=2&limit=50 failed: 503';
      expect(scrubber.scrubText(text), text);
    });
  });
}
