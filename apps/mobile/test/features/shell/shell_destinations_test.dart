import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/attendance_office/presentation/registers_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/parent_messages_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/parent_communication_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/teacher_messages_screen.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';
import 'package:studafy_mobile/src/features/shell/presentation/shell_destinations.dart';
import 'package:studafy_mobile/src/features/student/presentation/assignments_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/materials_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_timetable_screen.dart';

List<String> _labels(ShellRole role) => [
  for (final destination in shellDestinationsFor(role)) destination.labelKey,
];

void main() {
  test('student: Home, Lessons, Work, AI, Profile', () {
    expect(_labels(ShellRole.student), [
      'shell.tabs.home',
      'shell.tabs.lessons',
      'shell.tabs.work',
      'shell.tabs.ai',
      'shell.tabs.profile',
    ]);
    expect(
      shellDestinationsFor(ShellRole.student)[1].body,
      isA<MaterialsScreen>(),
    );
    expect(
      shellDestinationsFor(ShellRole.student)[2].body,
      isA<StudentAssignmentsScreen>(),
    );
  });

  test(
    'teacher: Home, Timetable, Classes, Messages, Profile — the timetable is the teacher view',
    () {
      expect(_labels(ShellRole.teacher), [
        'shell.tabs.home',
        'shell.tabs.timetable',
        'shell.tabs.classes',
        'shell.tabs.messages',
        'shell.tabs.profile',
      ]);
      expect(
        shellDestinationsFor(ShellRole.teacher)[1].body,
        isA<TeacherTimetableScreen>(),
      );
      expect(
        shellDestinationsFor(ShellRole.teacher)[3].body,
        isA<TeacherMessagesScreen>(),
      );
      expect(
        shellDestinationsFor(ShellRole.teacher)[3].decorateIcon,
        isNotNull,
      );
    },
  );

  test('parent: Home, Children, News, Messages, Profile', () {
    expect(_labels(ShellRole.parent), [
      'shell.tabs.home',
      'shell.tabs.children',
      'shell.tabs.news',
      'shell.tabs.messages',
      'shell.tabs.profile',
    ]);
    expect(
      shellDestinationsFor(ShellRole.parent)[2].body,
      isA<ParentCommunicationScreen>(),
    );
    expect(
      shellDestinationsFor(ShellRole.parent)[3].body,
      isA<ParentMessagesScreen>(),
    );
    expect(shellDestinationsFor(ShellRole.parent)[3].decorateIcon, isNotNull);
  });

  test('student and viewer get no Messages tab', () {
    expect(_labels(ShellRole.student), isNot(contains('shell.tabs.messages')));
    expect(_labels(ShellRole.viewer), isNot(contains('shell.tabs.messages')));
  });

  test('student, parent and viewer get no Timetable tab', () {
    expect(_labels(ShellRole.student), isNot(contains('shell.tabs.timetable')));
    expect(_labels(ShellRole.parent), isNot(contains('shell.tabs.timetable')));
    expect(_labels(ShellRole.viewer), [
      'shell.tabs.home',
      'shell.tabs.profile',
    ]);
  });

  test('attendance officer: Registers, Notifications, Profile', () {
    expect(_labels(ShellRole.attendanceOfficer), [
      'shell.tabs.registers',
      'shell.tabs.notifications',
      'shell.tabs.profile',
    ]);
    expect(
      shellDestinationsFor(ShellRole.attendanceOfficer).first.body,
      isA<RegistersScreen>(),
    );
  });
}
