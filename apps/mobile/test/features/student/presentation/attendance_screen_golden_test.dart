import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record_status.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/attendance_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/attendance_history.dart';
import 'package:studafy_mobile/src/features/student/presentation/attendance_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

StudentAttendanceEntry _entry(
  int month,
  int day,
  AttendanceRecordStatus status, {
  int? minutesLate,
  String? reason,
}) {
  return StudentAttendanceEntry(
    date: DateTime(2026, month, day),
    status: status,
    minutesLate: minutesLate,
    reason: reason,
  );
}

AttendanceHistoryStatus _history() {
  return AttendanceHistoryReady(
    assembleAttendanceHistory(
      entries: [
        _entry(8, 3, AttendanceRecordStatus.present),
        _entry(8, 6, AttendanceRecordStatus.present),
        _entry(8, 11, AttendanceRecordStatus.valueLate, minutesLate: 15, reason: 'Bus delay'),
        _entry(8, 18, AttendanceRecordStatus.excused, reason: 'Medical appointment'),
        _entry(8, 25, AttendanceRecordStatus.absent),
        _entry(7, 9, AttendanceRecordStatus.present),
        _entry(7, 14, AttendanceRecordStatus.absent, reason: 'Family travel'),
      ],
    ),
  );
}

Future<void> _pumpGolden(WidgetTester tester, Locale locale) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    KeyedSubtree(
      key: UniqueKey(),
      child: wrapWithLocalization(
        ProviderScope(
          overrides: [attendanceHistoryProvider.overrideWith((ref) => _history())],
          child: Builder(
            builder: (context) {
              return MediaQuery(
                data: const MediaQueryData(textScaler: TextScaler.noScaling),
                child: MaterialApp(
                  theme: AppTheme.light,
                  debugShowCheckedModeBanner: false,
                  locale: context.locale,
                  supportedLocales: context.supportedLocales,
                  localizationsDelegates: context.localizationDelegates,
                  home: const StudentAttendanceScreen(),
                ),
              );
            },
          ),
        ),
        startLocale: locale,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('attendance screen, loaded — English (LTR)', (tester) async {
    await _pumpGolden(tester, const Locale('en'));
    await expectLater(
      find.byType(StudentAttendanceScreen),
      matchesGoldenFile('goldens/attendance_screen_en.png'),
    );
  });

  testWidgets('attendance screen, loaded — Arabic (RTL)', (tester) async {
    await _pumpGolden(tester, const Locale('ar'));
    await expectLater(
      find.byType(StudentAttendanceScreen),
      matchesGoldenFile('goldens/attendance_screen_ar.png'),
    );
  });
}
