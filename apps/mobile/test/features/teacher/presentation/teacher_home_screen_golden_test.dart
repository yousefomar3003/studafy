import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/teacher_home.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_home_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

TeacherSession _session({
  required String id,
  required String classCode,
  required int period,
  required SessionAttendanceState attendance,
}) {
  return TeacherSession(
    slot: slotFixture(
      id: id,
      classId: 'class-$id',
      teacherId: 'teacher-1',
      weekday: DateTime.now().weekday,
      period: period,
    ),
    classCode: classCode,
    attendance: attendance,
  );
}

PendingSubmission _pending(String id, String title, DateTime submittedAt, {bool isLate = false}) {
  return PendingSubmission(
    assignment: assignmentFixture(id: 'a-$id', classId: 'class-1', title: title),
    submission: submissionFixture(
      id: id,
      assignmentId: 'a-$id',
      studentId: 'student-$id',
      submittedAt: submittedAt,
      isLate: isLate,
    ),
  );
}

Future<void> _pumpGolden(WidgetTester tester, Locale locale) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final now = DateTime.now();

  await tester.pumpWidget(
    KeyedSubtree(
      key: UniqueKey(),
      child: wrapWithLocalization(
        ProviderScope(
          overrides: [
            teacherTodaySessionsProvider.overrideWith(
              (ref) => [
                _session(
                  id: '1',
                  classCode: 'MATH101-A',
                  period: 1,
                  attendance: SessionAttendanceState.notStarted,
                ),
                _session(
                  id: '2',
                  classCode: 'MATH102-B',
                  period: 3,
                  attendance: SessionAttendanceState.recorded,
                ),
              ],
            ),
            teacherPendingSubmissionsProvider.overrideWith(
              (ref) => [
                _pending('1', 'Algebra Worksheet', now.subtract(const Duration(minutes: 20))),
                _pending('2', 'Essay Draft', now.subtract(const Duration(hours: 3)), isLate: true),
                _pending('3', 'Lab Report', now.subtract(const Duration(days: 1))),
              ],
            ),
          ],
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
                  home: const Scaffold(body: TeacherHomeScreen()),
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

  testWidgets('teacher home, loaded — English (LTR)', (tester) async {
    await _pumpGolden(tester, const Locale('en'));
    await expectLater(
      find.byType(TeacherHomeScreen),
      matchesGoldenFile('goldens/teacher_home_screen_en.png'),
    );
  });

  testWidgets('teacher home, loaded — Arabic (RTL)', (tester) async {
    await _pumpGolden(tester, const Locale('ar'));
    await expectLater(
      find.byType(TeacherHomeScreen),
      matchesGoldenFile('goldens/teacher_home_screen_ar.png'),
    );
  });
}
