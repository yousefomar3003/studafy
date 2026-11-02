import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/attendance_office/application/attendance_office_providers.dart';
import 'package:studafy_mobile/src/features/attendance_office/presentation/register_screen.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/teacher_home.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_home_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/teacher_section_card.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../../attendance_office/support.dart';
import '../support.dart';

TeacherSession _session(SessionAttendanceState attendance) => TeacherSession(
  slot: slotFixture(
    id: 's1',
    classId: 'class-1',
    teacherId: 'teacher-1',
    weekday: DateTime.now().weekday,
    period: 2,
  ),
  classCode: 'MATH101-A',
  attendance: attendance,
);

PendingSubmission _pending(String id, String title) => PendingSubmission(
  assignment: assignmentFixture(id: 'a-$id', classId: 'class-1', title: title),
  submission: submissionFixture(
    id: id,
    assignmentId: 'a-$id',
    studentId: 'student-$id',
    submittedAt: DateTime.utc(2026, 3, 1),
  ),
);

/// Takes the already-built [scope] rather than a raw overrides list — the `flutter_riverpod`
/// barrel this project pins doesn't export the `Override` type a `List<Override>` parameter
/// would need to name (same reason as `today_screen_test.dart`).
Future<void> _pumpHome(WidgetTester tester, ProviderScope scope) {
  return tester.pumpWidget(wrapWithLocalization(scope));
}

Widget _homeApp() {
  return Builder(
    builder: (context) => MaterialApp(
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      theme: AppTheme.light,
      home: const Scaffold(body: TeacherHomeScreen()),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows a skeleton for each card while loading', (tester) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider.overrideWith(
            (ref) => Completer<List<TeacherSession>>().future,
          ),
          teacherPendingSubmissionsProvider.overrideWith(
            (ref) => Completer<List<PendingSubmission>>().future,
          ),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pump();

    expect(find.byType(TeacherCardSkeleton), findsWidgets);
  });

  testWidgets('empty states read plainly, not as errors', (tester) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider.overrideWith(
            (ref) => <TeacherSession>[],
          ),
          teacherPendingSubmissionsProvider.overrideWith(
            (ref) => <PendingSubmission>[],
          ),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No sessions scheduled for today.'), findsOneWidget);
    expect(find.text('Nothing waiting to be graded.'), findsOneWidget);
    expect(find.text('No new submissions.'), findsOneWidget);
  });

  testWidgets('renders sessions, the pending count and recent submissions', (
    tester,
  ) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider.overrideWith(
            (ref) => [_session(SessionAttendanceState.notStarted)],
          ),
          teacherPendingSubmissionsProvider.overrideWith(
            (ref) => [_pending('1', 'Essay'), _pending('2', 'Lab Report')],
          ),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('MATH101-A'), findsOneWidget);
    expect(find.text('2 submissions awaiting a mark'), findsOneWidget);
    expect(find.text('Essay'), findsOneWidget);
    expect(find.text('Lab Report'), findsOneWidget);
  });

  testWidgets('each session shows its attendance state', (tester) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider.overrideWith(
            (ref) => [_session(SessionAttendanceState.recorded)],
          ),
          teacherPendingSubmissionsProvider.overrideWith(
            (ref) => <PendingSubmission>[],
          ),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Attendance recorded'), findsOneWidget);
    expect(find.text('Take attendance'), findsOneWidget);
  });

  group('take attendance', () {
    Future<void> pumpWithClasses(WidgetTester tester, List<Class> classes) {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      return _pumpHome(
        tester,
        ProviderScope(
          retry: (_, _) => null,
          overrides: [
            teacherTodaySessionsProvider.overrideWith(
              (ref) => [_session(SessionAttendanceState.notStarted)],
            ),
            teacherPendingSubmissionsProvider.overrideWith(
              (ref) => <PendingSubmission>[],
            ),
            teacherClassesProvider.overrideWith((ref) => classes),
            attendanceOfficeClientProvider.overrideWithValue(
              FakeAttendanceOfficeClient(
                rosters: {
                  for (final c in classes) c.id: ['s1'],
                },
                names: {'s1': 'Amal Saleh'},
              ),
            ),
            authStatusProvider.overrideWithValue(AuthStatus.authenticated),
            offlineDatabaseExecutorProvider.overrideWithValue(
              NativeDatabase.memory(),
            ),
          ],
          child: _homeApp(),
        ),
      );
    }

    testWidgets('with one class, opens its register directly', (tester) async {
      await pumpWithClasses(tester, [
        classFixture(id: 'class-1', code: 'MATH101-A'),
      ]);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Take attendance'));
      await tester.pumpAndSettle();

      final register = tester.widget<RegisterScreen>(
        find.byType(RegisterScreen),
      );
      expect(register.classId, 'class-1');
      expect(register.canCorrect, isFalse);
    });

    testWidgets('with several classes, asks which, today\'s first', (
      tester,
    ) async {
      await pumpWithClasses(tester, [
        classFixture(id: 'class-0', code: 'ART200-B'),
        classFixture(id: 'class-1', code: 'MATH101-A'),
      ]);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Take attendance'));
      await tester.pumpAndSettle();

      expect(find.text('Which class?'), findsOneWidget);
      final sheet = find.byType(BottomSheet);
      final today = tester.getTopLeft(
        find.descendant(of: sheet, matching: find.text('MATH101-A')),
      );
      final other = tester.getTopLeft(
        find.descendant(of: sheet, matching: find.text('ART200-B')),
      );
      expect(today.dy, lessThan(other.dy));

      await tester.tap(
        find.descendant(of: sheet, matching: find.text('ART200-B')),
      );
      await tester.pumpAndSettle();

      expect(
        tester.widget<RegisterScreen>(find.byType(RegisterScreen)).classId,
        'class-0',
      );
    });

    testWidgets('tapping a session opens that class\'s register', (
      tester,
    ) async {
      await pumpWithClasses(tester, [
        classFixture(id: 'class-1', code: 'MATH101-A'),
      ]);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Not taken yet'));
      await tester.pumpAndSettle();

      expect(
        tester.widget<RegisterScreen>(find.byType(RegisterScreen)).classId,
        'class-1',
      );
    });
  });
}
