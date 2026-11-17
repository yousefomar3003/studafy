import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/services.dart';
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
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'MATERIAL_PUBLISHED',
          'route': '/classes/k-1/materials',
        }),
        '/classes/k-1/materials',
      );
      expect(
        resolveNotificationTapRoute({
          'notification_type': 'MARKS_RELEASED',
          'route': '/students/st-1/marks',
        }),
        '/students/st-1/marks',
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

  group('describePushFailure', () {
    test(
      'a wrapped Java exception from a platform channel names the innermost cause',
      () {
        // What Firebase.initializeApp() threw on Android release builds 1.0.0 (1706): pigeon puts
        // the Java exception's toString() in the code and its class name in the message.
        final error = PlatformException(
          code:
              'java.util.concurrent.ExecutionException: java.util.concurrent.ExecutionException: '
              'java.util.concurrent.ExecutionException: java.lang.NullPointerException: '
              'FirebaseCrashlytics component is not present.',
          message: 'ExecutionException',
          details: 'Cause: ...\nStacktrace: ...',
        );
        expect(
          describePushFailure(error),
          'PlatformException: NullPointerException: FirebaseCrashlytics component is not present.',
        );
      },
    );

    test(
      'an ordinary platform error keeps its code and the first line of its message',
      () {
        final error = PlatformException(
          code: 'firebase_messaging',
          message: 'SERVICE_NOT_AVAILABLE\nmore detail',
        );
        expect(
          describePushFailure(error),
          'PlatformException(firebase_messaging): SERVICE_NOT_AVAILABLE',
        );
      },
    );

    test('a Firebase error names plugin and code', () {
      final error = FirebaseException(
        plugin: 'core',
        code: 'not-initialized',
        message: 'Firebase has not been correctly initialized.',
      );
      expect(
        describePushFailure(error),
        'FirebaseException(core/not-initialized): Firebase has not been correctly initialized.',
      );
    });

    test('HTTP failures name only the status', () {
      final request = RequestOptions(path: '/api/auth/devices');
      final error = DioException(
        requestOptions: request,
        response: Response(
          requestOptions: request,
          statusCode: 503,
          data: 'secret body',
        ),
      );
      expect(describePushFailure(error), 'HTTP 503');
    });

    test('other errors give their type and first line', () {
      expect(
        describePushFailure(StateError('boom\nsecond line')),
        'StateError: Bad state: boom',
      );
    });

    test('never shows a token-like string, and stays short', () {
      final token = '${'f' * 30}:APA91b${'x' * 140}';
      final described = describePushFailure(
        Exception('registration rejected for $token ${'y ' * 80}'),
      );
      expect(described, isNot(contains('APA91b')));
      expect(described.length, lessThanOrEqualTo(120));
      expect(described, endsWith('…'));
    });
  });
}
