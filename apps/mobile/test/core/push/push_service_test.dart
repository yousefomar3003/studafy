import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/push/push_service.dart';

void main() {
  group('resolveNotificationTapRoute', () {
    test(
      'ATTENDANCE_ALERT always routes to the parent alert center, ignoring route',
      () {
        expect(
          resolveNotificationTapRoute({
            'notification_type': 'ATTENDANCE_ALERT',
            'route': '/courses/{courseId}/attendance',
          }),
          '/parent/alerts',
        );
      },
    );

    test(
      'ATTENDANCE_ALERT with no route at all still routes to the alert center',
      () {
        expect(
          resolveNotificationTapRoute({
            'notification_type': 'ATTENDANCE_ALERT',
          }),
          '/parent/alerts',
        );
      },
    );

    test('ATTENDANCE_MARKED routes to the parent alert center too', () {
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'ATTENDANCE_MARKED',
          'route': '/',
        }),
        '/parent/alerts',
      );
    });

    test('an openable payload route is followed', () {
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'GRADE_POSTED',
          'route': '/courses/c-1/grades',
        }),
        '/courses/c-1/grades',
      );
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'ASSIGNMENT_PUBLISHED',
          'route': '/courses/c-1/assignments/a-1',
        }),
        '/courses/c-1/assignments/a-1',
      );
    });

    test('anything the app cannot open lands in the notification inbox', () {
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'DIRECT_MESSAGE',
          'route': '/messages/c-1',
        }),
        '/notifications',
      );
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'GRADE_POSTED',
          'route': '',
        }),
        '/notifications',
      );
      expect(
        resolveNotificationTapRoute({'notification_type': 'GRADE_POSTED'}),
        '/notifications',
      );
    });

    test('a payload with no notification type navigates nowhere', () {
      expect(resolveNotificationTapRoute(const {}), isNull);
    });
  });
}
