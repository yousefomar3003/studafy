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
}
