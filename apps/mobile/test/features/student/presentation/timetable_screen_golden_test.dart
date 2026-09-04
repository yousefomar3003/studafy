import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/timetable_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/timetable_week.dart';
import 'package:studafy_mobile/src/features/student/presentation/timetable_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

final _weekStart = DateTime(2026, 8, 24);

TimetableSlot _slot(int weekday, int period) {
  final now = DateTime(2026, 1, 1);
  return TimetableSlot(
    id: 'slot-$weekday-$period',
    schoolId: 'school-1',
    timetableVersionId: 'version-1',
    classId: 'class-1',
    teacherId: 'teacher-1',
    roomId: 'room-1',
    weekday: weekday,
    period: period,
    createdAt: now,
    updatedAt: now,
  );
}

Exam _exam(String title, DateTime startsAt) {
  return Exam.fromJson({
    'id': 'exam-$title',
    'school_id': 'school-1',
    'class_id': 'class-1',
    'created_by_user_id': 'user-1',
    'last_edited_by_user_id': 'user-1',
    'title': title,
    'description': null,
    'status': 'scheduled',
    'starts_at': startsAt.toUtc().toIso8601String(),
    'ends_at': startsAt
        .add(const Duration(hours: 1, minutes: 30))
        .toUtc()
        .toIso8601String(),
    'max_score': 100,
    'room_id': null,
    'weight': 1,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

CachedValue<TimetableWeek> _week() {
  return CachedValue(
    data: TimetableWeek(
      weekStart: _weekStart,
      days: [
        TimetableDay(
          date: _weekStart,
          weekday: 1,
          slots: [_slot(1, 1), _slot(1, 2), _slot(1, 3)],
          exams: const [],
        ),
        TimetableDay(
          date: _weekStart.add(const Duration(days: 2)),
          weekday: 3,
          slots: [_slot(3, 1), _slot(3, 2)],
          exams: [_exam('Midterm Mathematics', DateTime(2026, 8, 26, 9))],
        ),
      ],
    ),
    fetchedAt: DateTime(2026, 8, 24, 8),
    source: CacheSource.network,
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
            timetableWeekProvider.overrideWith(
              (ref) =>
                  AsyncData<TimetableWeekStatus>(TimetableWeekReady(_week())),
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
