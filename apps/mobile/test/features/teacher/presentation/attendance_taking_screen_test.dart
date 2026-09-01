import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_session.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/attendance_taking_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_taking.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/attendance_taking_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/attendance_roster_row.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

const _t0 = '2026-01-01T00:00:00.000Z';
const _scope = (classId: 'class-1', period: 2);

AttendanceRecord _record(String studentId, String status) => AttendanceRecord.fromJson({
  'id': 'rec-$studentId',
  'school_id': 'school-1',
  'attendance_session_id': 'session-1',
  'student_id': studentId,
  'status': status,
  'minutes_late': null,
  'reason': null,
  'recorded_by_user_id': 'user-1',
  'created_at': _t0,
});

AttendanceSession _submittedSession() => AttendanceSession.fromJson({
  'id': 'session-1',
  'school_id': 'school-1',
  'class_id': 'class-1',
  'session_date': _t0,
  'period': 2,
  'status': 'submitted',
  'taken_by_user_id': 'user-1',
  'created_at': _t0,
  'updated_at': _t0,
});

Widget _screenApp() => Builder(
  builder: (context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    locale: context.locale,
    supportedLocales: context.supportedLocales,
    localizationsDelegates: context.localizationDelegates,
    theme: AppTheme.light,
  home: const AttendanceTakingScreen(classId: 'class-1', classCode: 'MATH101-A', period: 2),
  ),
);

Future<void> _pump(
  WidgetTester tester, {
  required AttendanceRegister register,
  FakeAttendanceClient? client,
}) {
  return tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          offlineDatabaseExecutorProvider.overrideWithValue(NativeDatabase.memory()),
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(attendance: client ?? FakeAttendanceClient()),
          ),
          attendanceRegisterProvider(_scope).overrideWith((ref) async => register),
        ],
        child: _screenApp(),
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('every student defaults to present', (tester) async {
    await _pump(
      tester,
      register: AttendanceTakingRegister(
        roster: [enrollmentFixture(studentId: 's1'), enrollmentFixture(studentId: 's2')],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(AttendanceRosterRow), findsNWidgets(2));
    expect(find.text('Present'), findsNWidgets(2));
  });

  testWidgets('tapping a row cycles that student to absent', (tester) async {
    await _pump(
      tester,
      register: AttendanceTakingRegister(
        roster: [enrollmentFixture(studentId: 's1'), enrollmentFixture(studentId: 's2')],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byType(AttendanceRosterRow).first);
    await tester.pumpAndSettle();

    expect(find.text('Absent'), findsOneWidget);
    expect(find.text('Present'), findsOneWidget);
  });

  testWidgets('submit records the batch and confirms', (tester) async {
    final client = FakeAttendanceClient();
    await _pump(
      tester,
      client: client,
      register: AttendanceTakingRegister(roster: [enrollmentFixture(studentId: 's1')]),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Submit attendance'));
    await tester.pumpAndSettle();

    expect(client.batchCalls, hasLength(1));
    expect(client.submittedSessionIds, hasLength(1));
    expect(find.text('Attendance submitted.'), findsOneWidget);
  });

  testWidgets('an offline submit shows the saved-on-device notice', (tester) async {
    final client = FakeAttendanceClient()
      ..throwOnWrite = DioException(
        requestOptions: RequestOptions(path: '/'),
        type: DioExceptionType.connectionError,
      );
    await _pump(
      tester,
      client: client,
      register: AttendanceTakingRegister(roster: [enrollmentFixture(studentId: 's1')]),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Submit attendance'));
    await tester.pumpAndSettle();

    expect(
      find.text("Saved on this device — it will sync when you're back online."),
      findsWidgets,
    );
  });

  testWidgets('a recorded register shows pills and opens the correction sheet', (tester) async {
    await _pump(
      tester,
      register: RecordedRegister(
        roster: [enrollmentFixture(studentId: 's1')],
        session: _submittedSession(),
        records: [_record('s1', 'absent')],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Absent'), findsOneWidget);

    await tester.tap(find.text('Absent'));
    await tester.pumpAndSettle();

    expect(find.text('Correct attendance'), findsOneWidget);
  });
}
