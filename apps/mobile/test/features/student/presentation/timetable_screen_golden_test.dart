import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/presentation/timetable_screen.dart';
import 'package:studafy_mobile/src/features/timetable/application/weekly_schedule_providers.dart';
import 'package:studafy_mobile/src/features/timetable/domain/weekly_schedule.dart';
import 'package:studafy_mobile/src/features/timetable/presentation/weekly_schedule_view.dart';
import 'package:studafy_mobile/src/features/timetable/presentation/widgets/lesson_card.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../../timetable/support.dart';

WeeklyScheduleStatus _schedule() {
  return WeeklyScheduleReady(
    liveValue(
      buildWeeklySchedule(
        schoolDays: const [7, 1, 2, 3, 4],
        slots: [
          scheduleSlot(weekday: 1, period: 1, classId: 'sci'),
          scheduleSlot(weekday: 1, period: 2, classId: 'math'),
          scheduleSlot(weekday: 3, period: 1, classId: 'sci'),
        ],
      ),
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
          overrides: [
            studentWeeklyScheduleProvider.overrideWith(
              (ref) => AsyncData(_schedule()),
            ),
            scheduleClockProvider.overrideWithValue(() => scheduleMonday),
            scheduleClassLabelProvider.overrideWith(
              (ref, classId) async => classId == 'sci'
                  ? (code: 'SCI101-A', courseName: 'Integrated Science')
                  : (code: 'MATH101-A', courseName: 'Algebra Foundations'),
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
                  home: const Scaffold(body: TimetableScreen()),
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

  testWidgets(
    'timetable screen, loaded — English (LTR)',
    (tester) async {
      await _pumpGolden(tester, const Locale('en'));
      await expectLater(
        find.byType(TimetableScreen),
        matchesGoldenFile('goldens/timetable_screen_en.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );

  testWidgets(
    'timetable screen, loaded — Arabic (RTL)',
    (tester) async {
      await _pumpGolden(tester, const Locale('ar'));
      await expectLater(
        find.byType(TimetableScreen),
        matchesGoldenFile('goldens/timetable_screen_ar.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );
}
