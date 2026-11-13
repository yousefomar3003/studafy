import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/notifications/domain/notification_target.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';

void main() {
  group('isOpenableNotificationRoute', () {
    test(
      'accepts filled-in assignment and grades links and the parent alert center',
      () {
        expect(
          isOpenableNotificationRoute('/courses/c-1/assignments/a-1'),
          isTrue,
        );
        expect(isOpenableNotificationRoute('/courses/c-1/grades'), isTrue);
        expect(isOpenableNotificationRoute('/parent/alerts'), isTrue);
      },
    );

    test('rejects placeholders, web-only pages and empty routes', () {
      expect(
        isOpenableNotificationRoute('/courses/{courseId}/grades'),
        isFalse,
      );
      expect(isOpenableNotificationRoute('/messages/c-1'), isFalse);
      expect(isOpenableNotificationRoute('/'), isFalse);
      expect(isOpenableNotificationRoute(''), isFalse);
      expect(isOpenableNotificationRoute(null), isFalse);
    });
  });

  group('notificationTargetFor', () {
    test('a student opens a new assignment', () {
      final target = notificationTargetFor(
        type: 'ASSIGNMENT_PUBLISHED',
        metadata: {'route': '/courses/c-1/assignments/a-1'},
        role: ShellRole.student,
      );
      expect(target.route, '/courses/c-1/assignments/a-1');
    });

    test('a student without a usable link lands on the Work tab', () {
      final target = notificationTargetFor(
        type: 'ASSIGNMENT_GRADED',
        metadata: const {},
        role: ShellRole.student,
      );
      expect(target.tabLabelKey, 'shell.tabs.work');
    });

    test("a parent's school-work notices open the Children tab", () {
      final target = notificationTargetFor(
        type: 'ASSIGNMENT_PUBLISHED',
        metadata: {'route': '/'},
        role: ShellRole.parent,
      );
      expect(target.tabLabelKey, 'shell.tabs.children');
    });

    test('attendance notices open the parent alert center', () {
      for (final type in ['ATTENDANCE_ALERT', 'ATTENDANCE_MARKED']) {
        final target = notificationTargetFor(
          type: type,
          metadata: const {},
          role: ShellRole.parent,
        );
        expect(target.route, '/parent/alerts', reason: type);
      }
    });

    test('a message opens the Messages tab for teachers and parents', () {
      for (final role in [ShellRole.teacher, ShellRole.parent]) {
        final target = notificationTargetFor(
          type: 'DIRECT_MESSAGE',
          metadata: {'route': '/messages/c-1'},
          role: role,
        );
        expect(target.tabLabelKey, 'shell.tabs.messages', reason: '$role');
      }
    });

    test('anything else shows its full text in place', () {
      final target = notificationTargetFor(
        type: 'LICENSE_EXPIRING',
        metadata: {'route': '/'},
        role: ShellRole.viewer,
      );
      expect(target.isNone, isTrue);
    });
  });
}
