import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/teacher_home.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_class_detail_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_home_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/teacher_section_card.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
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
          teacherTodaySessionsProvider
              .overrideWith((ref) => Completer<List<TeacherSession>>().future),
          teacherPendingSubmissionsProvider
              .overrideWith((ref) => Completer<List<PendingSubmission>>().future),
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
          teacherTodaySessionsProvider.overrideWith((ref) => <TeacherSession>[]),
          teacherPendingSubmissionsProvider.overrideWith((ref) => <PendingSubmission>[]),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No sessions scheduled for today.'), findsOneWidget);
    expect(find.text('Nothing waiting to be graded.'), findsOneWidget);
    expect(find.text('No new submissions.'), findsOneWidget);
  });

  testWidgets('renders sessions, the pending count and recent submissions', (tester) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider
              .overrideWith((ref) => [_session(SessionAttendanceState.notStarted)]),
          teacherPendingSubmissionsProvider
              .overrideWith((ref) => [_pending('1', 'Essay'), _pending('2', 'Lab Report')]),
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

  testWidgets('the take-attendance CTA reflects attendance state', (tester) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider
              .overrideWith((ref) => [_session(SessionAttendanceState.recorded)]),
          teacherPendingSubmissionsProvider.overrideWith((ref) => <PendingSubmission>[]),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    final button = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(button.onPressed, isNull);
    expect(find.text('Attendance recorded'), findsOneWidget);
  });

  testWidgets('tapping take attendance opens the class detail screen', (tester) async {
    await _pumpHome(
      tester,
      ProviderScope(
        overrides: [
          teacherTodaySessionsProvider
              .overrideWith((ref) => [_session(SessionAttendanceState.notStarted)]),
          teacherPendingSubmissionsProvider.overrideWith((ref) => <PendingSubmission>[]),
          classRosterProvider('class-1').overrideWith((ref) => <Enrollment>[]),
          classCourseNameProvider('class-1').overrideWith((ref) => 'Mathematics'),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Take attendance'));
    await tester.pumpAndSettle();

    expect(find.byType(TeacherClassDetailScreen), findsOneWidget);
  });
}
