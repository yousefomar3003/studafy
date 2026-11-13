import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record_status.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/attendance_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/attendance_history.dart';
import 'package:studafy_mobile/src/features/student/presentation/attendance_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/attendance_month_section.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/attendance_status_pill.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/status_pill.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

StudentAttendanceEntry _entry(
  int day,
  AttendanceRecordStatus status, {
  int? minutesLate,
  String? reason,
}) {
  return StudentAttendanceEntry(
    date: DateTime(2026, 8, day),
    status: status,
    minutesLate: minutesLate,
    reason: reason,
  );
}

AttendanceHistoryStatus _populated() {
  return AttendanceHistoryReady(
    assembleAttendanceHistory(
      entries: [
        _entry(3, AttendanceRecordStatus.present),
        _entry(11, AttendanceRecordStatus.valueLate, minutesLate: 15, reason: 'Bus delay'),
        _entry(18, AttendanceRecordStatus.excused, reason: 'Medical appointment'),
        _entry(25, AttendanceRecordStatus.absent),
      ],
    ),
  );
}

Widget _screen(
  FutureOr<AttendanceHistoryStatus> Function(Ref ref) override,
) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [attendanceHistoryProvider.overrideWith(override)],
      child: Builder(
        builder: (context) {
          return MaterialApp(
            theme: AppTheme.light,
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const StudentAttendanceScreen(),
          );
        },
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows a spinner while the history is still loading', (tester) async {
    final pending = Completer<AttendanceHistoryStatus>();
    addTearDown(() => pending.complete(const AttendanceHistoryUnavailable()));

    await tester.pumpWidget(_screen((ref) => pending.future));
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('shows the unavailable message when the records seam is unresolved', (
    tester,
  ) async {
    await tester.pumpWidget(_screen((ref) => const AttendanceHistoryUnavailable()));
    await tester.pumpAndSettle();

    expect(find.text("Your attendance isn't available yet."), findsOneWidget);
  });

  testWidgets('shows the error message when the history fails to load', (tester) async {
    await tester.pumpWidget(
      _screen((ref) => Future<AttendanceHistoryStatus>.error(Exception('boom'))),
    );
    await tester.pumpAndSettle();

    expect(find.text("Couldn't load your attendance."), findsOneWidget);
  });

  testWidgets('shows the empty message when no attendance is recorded', (tester) async {
    await tester.pumpWidget(
      _screen((ref) => AttendanceHistoryReady(assembleAttendanceHistory(entries: const []))),
    );
    await tester.pumpAndSettle();

    expect(find.text('No attendance recorded yet.'), findsOneWidget);
  });

  testWidgets('renders a section per month with its summary and absence detail', (tester) async {
    await tester.pumpWidget(_screen((ref) => _populated()));
    await tester.pumpAndSettle();

    expect(find.byType(AttendanceMonthSection), findsOneWidget);
    expect(find.text('August 2026'), findsOneWidget);
    // present 1 · absent 1 · late 1 · excused 1
    expect(find.text('1 present · 1 absent · 1 late · 1 excused'), findsOneWidget);
    // (present + late) / total = 2 / 4
    expect(find.text('50% attendance'), findsOneWidget);
    expect(find.textContaining('Bus delay'), findsOneWidget);
    expect(find.textContaining('Medical appointment'), findsOneWidget);
    expect(find.textContaining('15 min late'), findsOneWidget);
    // the absent day has no reason of its own
    expect(find.text('No reason recorded'), findsOneWidget);
  });

  testWidgets('the present day is not listed as an exception', (tester) async {
    await tester.pumpWidget(_screen((ref) => _populated()));
    await tester.pumpAndSettle();

    // 3 non-present days -> 3 pills; the on-time Aug 3 attendance is summarised only.
    expect(find.byType(AttendanceStatusPill), findsNWidgets(3));
    expect(find.text('Present'), findsNothing);
  });

  testWidgets('late and excused pills use distinct tones', (tester) async {
    await tester.pumpWidget(_screen((ref) => _populated()));
    await tester.pumpAndSettle();

    StatusPill pillWith(String label) => tester.widget<StatusPill>(
      find.ancestor(of: find.text(label), matching: find.byType(StatusPill)),
    );

    final tones = {
      pillWith('Late').tone,
      pillWith('Excused').tone,
      pillWith('Absent').tone,
    };
    expect(tones, hasLength(3));
  });

  testWidgets('a full-attendance month says so instead of listing absences', (tester) async {
    await tester.pumpWidget(
      _screen(
        (ref) => AttendanceHistoryReady(
          assembleAttendanceHistory(
            entries: [
              _entry(1, AttendanceRecordStatus.present),
              _entry(2, AttendanceRecordStatus.present),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Full attendance this month.'), findsOneWidget);
    expect(find.byType(AttendanceStatusPill), findsNothing);
  });
}
