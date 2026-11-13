import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/push/push_service.dart';

void main() {
  group('resolveNotificationTapRoute', () {
    test('ATTENDANCE_ALERT always routes to the parent alert center, ignoring route', () {
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'ATTENDANCE_ALERT',
          'route': '/courses/{courseId}/attendance',
        }),
        '/parent/alerts',
      );
    });

    test('ATTENDANCE_ALERT with no route at all still routes to the alert center', () {
      expect(
        resolveNotificationTapRoute({'notification_type': 'ATTENDANCE_ALERT'}),
        '/parent/alerts',
      );
    });

    test('other types fall back to the payload route', () {
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'GRADE_POSTED',
          'route': '/courses/c-1/grades',
        }),
        '/courses/c-1/grades',
      );
    });

    test('an empty or missing route resolves to no navigation', () {
      expect(resolveNotificationTapRoute({'notification_type': 'GRADE_POSTED', 'route': ''}), isNull);
      expect(resolveNotificationTapRoute({'notification_type': 'GRADE_POSTED'}), isNull);
    });
  });
}
