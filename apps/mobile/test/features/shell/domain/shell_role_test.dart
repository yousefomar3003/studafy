import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';

void main() {
  group('resolveShellRole', () {
    test('student claim resolves to the student shell', () {
      expect(resolveShellRole(['STUDENT']), ShellRole.student);
    });

    test('instructor claim resolves to the teacher shell', () {
      expect(resolveShellRole(['INSTRUCTOR']), ShellRole.teacher);
    });

    test('parent claim resolves to the parent shell', () {
      expect(resolveShellRole(['PARENT']), ShellRole.parent);
    });

    for (final adminRole in [
      'SUPER_ADMIN',
      'ORG_ADMIN',
      'FINANCE',
      'SUPPORT_AGENT',
    ]) {
      test('$adminRole claim resolves to the viewer shell', () {
        expect(resolveShellRole([adminRole]), ShellRole.viewer);
      });
    }

    test('guest claim resolves to the viewer shell', () {
      expect(resolveShellRole(['GUEST']), ShellRole.viewer);
    });

    test('no roles at all resolves to the viewer shell', () {
      expect(resolveShellRole(const []), ShellRole.viewer);
    });

    test('an unrecognized claim resolves to the viewer shell', () {
      expect(resolveShellRole(['SOME_FUTURE_ROLE']), ShellRole.viewer);
    });

    test(
      'an admin-type role wins over a teaching role on the same session',
      () {
        expect(resolveShellRole(['INSTRUCTOR', 'ORG_ADMIN']), ShellRole.viewer);
      },
    );

    test('an admin-type role wins over a student role on the same session', () {
      expect(resolveShellRole(['STUDENT', 'SUPER_ADMIN']), ShellRole.viewer);
    });

    test('a teaching role wins over a student role on the same session', () {
      expect(resolveShellRole(['STUDENT', 'INSTRUCTOR']), ShellRole.teacher);
    });

    test(
      'attendance officer claim resolves to the attendance officer shell',
      () {
        expect(
          resolveShellRole(['ATTENDANCE_OFFICER']),
          ShellRole.attendanceOfficer,
        );
      },
    );

    test('attendance officer wins over teaching, student and parent roles', () {
      expect(
        resolveShellRole(['INSTRUCTOR', 'ATTENDANCE_OFFICER']),
        ShellRole.attendanceOfficer,
      );
      expect(
        resolveShellRole([
          'INSTRUCTOR',
          'STUDENT',
          'PARENT',
          'ATTENDANCE_OFFICER',
        ]),
        ShellRole.attendanceOfficer,
      );
    });

    test('an admin-type role still wins over attendance officer', () {
      expect(
        resolveShellRole(['ATTENDANCE_OFFICER', 'ORG_ADMIN']),
        ShellRole.viewer,
      );
      expect(
        resolveShellRole(['ATTENDANCE_OFFICER', 'FINANCE']),
        ShellRole.viewer,
      );
    });
  });

  group('ShellRoleMutation.canMutate', () {
    test('every shell but viewer can mutate', () {
      expect(ShellRole.student.canMutate, isTrue);
      expect(ShellRole.teacher.canMutate, isTrue);
      expect(ShellRole.parent.canMutate, isTrue);
      expect(ShellRole.attendanceOfficer.canMutate, isTrue);
      expect(ShellRole.viewer.canMutate, isFalse);
    });
  });
}
