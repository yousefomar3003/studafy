import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/correct_attendance_record_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/corrected_attendance_record.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/attendance_office/application/attendance_office_providers.dart';
import 'package:studafy_mobile/src/features/attendance_office/presentation/register_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../../teacher/support.dart';
import '../support.dart';

/// Captures every correction PATCH body.
class _RecordingAttendanceClient extends FakeAttendanceClient {
  final List<({String recordId, Map<String, dynamic> body})> corrections = [];

  @override
  Future<CorrectedAttendanceRecord> correctAttendanceRecord({
    required String recordId,
    required CorrectAttendanceRecordBody body,
  }) {
    corrections.add((recordId: recordId, body: body.toJson()));
    return super.correctAttendanceRecord(recordId: recordId, body: body);
  }
}

final _date = DateTime(2026, 10, 13);

Future<void> _pump(
  WidgetTester tester,
  FakeAttendanceOfficeClient office, {
  _RecordingAttendanceClient? attendance,
  bool canCorrect = true,
}) async {
  // Tall enough that the whole roster and the submit bar are on screen.
  tester.view.physicalSize = const Size(1200, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        retry: (_, _) => null,
        overrides: [
          attendanceOfficeClientProvider.overrideWithValue(office),
          authStatusProvider.overrideWithValue(AuthStatus.authenticated),
          offlineDatabaseExecutorProvider.overrideWithValue(
            NativeDatabase.memory(),
          ),
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(
              attendance: attendance ?? _RecordingAttendanceClient(),
            ),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: RegisterScreen(
              classId: 'c1',
              classCode: '7A',
              date: _date,
              canCorrect: canCorrect,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _confirmSubmit(WidgetTester tester, {required int count}) async {
  await tester.tap(find.text('Submit register ($count)'));
  await tester.pumpAndSettle();
  expect(find.text('Submit register?'), findsOneWidget);
  await tester.tap(find.widgetWithText(FilledButton, 'Submit'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('roster is sorted by name and defaults everyone to present', (
    tester,
  ) async {
    final office = FakeAttendanceOfficeClient(
      rosters: {
        'c1': ['s1', 's2'],
      },
      names: {'s1': 'Zaid Omar', 's2': 'Amal Saleh'},
    );
    await _pump(tester, office);

    final amal = tester.getTopLeft(find.text('Amal Saleh')).dy;
    final zaid = tester.getTopLeft(find.text('Zaid Omar')).dy;
    expect(amal, lessThan(zaid));
    expect(
      find.text('2 present · 0 absent · 0 late · 0 excused'),
      findsOneWidget,
    );
    expect(find.text('Submit register (2)'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Attendance for Amal Saleh: Absent'),
      findsOneWidget,
    );
  });

  testWidgets('submit opens the session, records the batch and submits it', (
    tester,
  ) async {
    final office = FakeAttendanceOfficeClient(
      rosters: {
        'c1': ['s1', 's2'],
      },
      names: {'s1': 'Amal Saleh', 's2': 'Zaid Omar'},
    );
    await _pump(tester, office);

    await tester.tap(find.bySemanticsLabel('Attendance for Zaid Omar: Absent'));
    await tester.pumpAndSettle();
    await _confirmSubmit(tester, count: 2);

    expect(office.calls, [
      'open:c1',
      'batch:session-c1:2',
      'status:session-c1:submitted',
    ]);
    expect(office.batches.single, [
      {'student_id': 's1', 'status': 'present'},
      {'student_id': 's2', 'status': 'absent'},
    ]);
    expect(find.text('Register submitted.'), findsOneWidget);
    // Now read-only with a Correct action per record.
    expect(find.text('Correct'), findsNWidgets(2));
  });

  testWidgets('late requires minutes before anything is sent', (tester) async {
    final office = FakeAttendanceOfficeClient(
      rosters: {
        'c1': ['s1'],
      },
      names: {'s1': 'Amal Saleh'},
    );
    await _pump(tester, office);

    await tester.tap(find.bySemanticsLabel('Attendance for Amal Saleh: Late'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Submit register (1)'));
    await tester.pumpAndSettle();

    expect(find.text('Submit register?'), findsNothing);
    expect(
      find.text('Enter the minutes late (1 or more) for every late student.'),
      findsOneWidget,
    );
    expect(find.text('1 or more'), findsOneWidget);
    expect(office.calls, isEmpty);

    // Let the validation snack bar clear off the submit bar.
    ScaffoldMessenger.of(
      tester.element(find.byType(RegisterScreen)),
    ).clearSnackBars();
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('minutes-s1')), '7');
    await tester.pumpAndSettle();
    await _confirmSubmit(tester, count: 1);

    expect(office.batches.single, [
      {'student_id': 's1', 'status': 'late', 'minutes_late': 7},
    ]);
  });

  testWidgets(
    'students already recorded are shown as recorded and not re-sent',
    (tester) async {
      final open = dailySession(classId: 'c1', status: 'open');
      final office = FakeAttendanceOfficeClient(
        rosters: {
          'c1': ['s1', 's2'],
        },
        names: {'s1': 'Amal Saleh', 's2': 'Zaid Omar'},
        sessions: {'c1': open},
        records: {
          open.id: [
            recordFixture(
              studentId: 's1',
              sessionId: open.id,
              status: 'remote',
            ),
          ],
        },
      );
      await _pump(tester, office);

      expect(find.text('Already recorded'), findsOneWidget);
      expect(find.text('Remote'), findsOneWidget);
      expect(
        find.bySemanticsLabel('Attendance for Amal Saleh: Absent'),
        findsNothing,
      );

      await _confirmSubmit(tester, count: 1);

      expect(office.calls, [
        'batch:session-c1:1',
        'status:session-c1:submitted',
      ]);
      expect(office.batches.single, [
        {'student_id': 's2', 'status': 'present'},
      ]);
    },
  );

  testWidgets('an offline submit keeps the marks and says nothing was sent', (
    tester,
  ) async {
    final office =
        FakeAttendanceOfficeClient(
            rosters: {
              'c1': ['s1'],
            },
            names: {'s1': 'Amal Saleh'},
          )
          ..throwOnWrite = DioException(
            requestOptions: RequestOptions(path: '/'),
            type: DioExceptionType.connectionError,
          );
    await _pump(tester, office);

    await tester.tap(
      find.bySemanticsLabel('Attendance for Amal Saleh: Excused'),
    );
    await tester.pumpAndSettle();
    await _confirmSubmit(tester, count: 1);

    expect(
      find.text(
        "You're offline, so nothing was submitted. Check your connection and try again.",
      ),
      findsOneWidget,
    );
    expect(find.text('Submit register (1)'), findsOneWidget);
    expect(
      find.text('0 present · 0 absent · 0 late · 1 excused'),
      findsOneWidget,
    );
  });

  group('submitted register', () {
    FakeAttendanceOfficeClient submitted() {
      final session = dailySession(classId: 'c1', status: 'submitted');
      return FakeAttendanceOfficeClient(
        rosters: {
          'c1': ['s1'],
        },
        names: {'s1': 'Amal Saleh'},
        sessions: {'c1': session},
        records: {
          session.id: [
            recordFixture(
              studentId: 's1',
              sessionId: session.id,
              status: 'absent',
            ),
          ],
        },
      );
    }

    Future<void> correctToLate(WidgetTester tester) async {
      await tester.tap(
        find.bySemanticsLabel('Correct attendance for Amal Saleh'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, 'Late'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField),
        'Arrived after first bell',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save correction'));
      await tester.pumpAndSettle();
    }

    testWidgets('shows the recorded status read-only with Correct', (
      tester,
    ) async {
      await _pump(tester, submitted());

      expect(find.text('Absent'), findsOneWidget);
      expect(find.text('Correct'), findsOneWidget);
      expect(find.textContaining('Submit register'), findsNothing);
      expect(find.bySemanticsLabel(RegExp('Attendance for')), findsNothing);
    });

    testWidgets('a teacher sees it read-only, without Correct', (tester) async {
      await _pump(tester, submitted(), canCorrect: false);

      expect(find.text('Absent'), findsOneWidget);
      expect(find.text('Correct'), findsNothing);
      expect(find.textContaining('ask the attendance office'), findsOneWidget);
    });

    testWidgets('a correction PATCHes status, minutes late and reason', (
      tester,
    ) async {
      final attendance = _RecordingAttendanceClient();
      await _pump(tester, submitted(), attendance: attendance);

      await correctToLate(tester);

      expect(attendance.corrections.single.recordId, 'rec-s1');
      expect(attendance.corrections.single.body, {
        'status': 'late',
        'minutes_late': 1,
        'reason': 'Arrived after first bell',
      });
      expect(find.text('Correction saved.'), findsOneWidget);
    });

    testWidgets('an expired window says to ask the principal', (tester) async {
      final attendance = _RecordingAttendanceClient()
        ..throwOnCorrect = apiErrorFor(
          'ATTENDANCE_CORRECTION_WINDOW_EXPIRED',
          status: 422,
        );
      await _pump(tester, submitted(), attendance: attendance);

      await correctToLate(tester);

      expect(
        find.text('The correction window has closed — ask the principal.'),
        findsOneWidget,
      );
    });
  });

  testWidgets('a load failure shows an error with retry', (tester) async {
    final office = _FailingRosterClient();
    await _pump(tester, office);

    expect(find.text("Couldn't load this register."), findsOneWidget);
    office.fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Amal Saleh'), findsOneWidget);
  });

  testWidgets('names fall back to a short id when the roster is unavailable', (
    tester,
  ) async {
    final office = FakeAttendanceOfficeClient(
      rosters: {
        'c1': ['student-abcdef'],
      },
    )..namesFail = true;
    await _pump(tester, office);

    expect(find.text('Student abcdef'), findsOneWidget);
  });
}

class _FailingRosterClient extends FakeAttendanceOfficeClient {
  _FailingRosterClient()
    : super(
        rosters: {
          'c1': ['s1'],
        },
        names: {'s1': 'Amal Saleh'},
      );

  bool fail = true;

  @override
  Future<List<String>> listRoster(String classId) async {
    if (fail) throw StateError('offline');
    return super.listRoster(classId);
  }
}
