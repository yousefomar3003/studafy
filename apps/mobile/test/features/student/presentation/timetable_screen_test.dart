import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/core/offline/staleness_banner.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/timetable_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/timetable_week.dart';
import 'package:studafy_mobile/src/features/student/presentation/timetable_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/timetable_day_section.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/timetable_placeholders.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/timetable_week_navigator.dart';

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
    'ends_at': startsAt.add(const Duration(hours: 1)).toUtc().toIso8601String(),
    'max_score': 100,
    'room_id': null,
    'weight': 1,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

TimetableWeek _week() {
  return TimetableWeek(
    weekStart: _weekStart,
    days: [
      TimetableDay(
        date: _weekStart,
        weekday: 1,
        slots: [_slot(1, 1), _slot(1, 2)],
        exams: const [],
      ),
      TimetableDay(
        date: _weekStart.add(const Duration(days: 2)),
        weekday: 3,
        slots: [_slot(3, 1)],
        exams: [_exam('Midterm Mathematics', DateTime(2026, 8, 26, 9))],
      ),
    ],
  );
}

CachedValue<TimetableWeek> _cached({required bool stale}) {
  return CachedValue(
    data: _week(),
    fetchedAt: DateTime(2026, 8, 24, 8),
    source: stale ? CacheSource.cache : CacheSource.network,
  );
}

Widget _screenScope(AsyncValue<TimetableWeekStatus> status) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [timetableWeekProvider.overrideWith((ref) => status)],
      child: Builder(
        builder: (context) {
          return MaterialApp(
            theme: AppTheme.light,
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const Scaffold(body: TimetableScreen()),
          );
        },
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows the skeleton while the week is still loading', (tester) async {
    await tester.pumpWidget(_screenScope(const AsyncLoading<TimetableWeekStatus>()));
    await tester.pump();

    expect(find.byType(TimetableSkeleton), findsOneWidget);
  });

  testWidgets('shows the unavailable message when the student context is unresolved', (
    tester,
  ) async {
    await tester.pumpWidget(
      _screenScope(const AsyncData<TimetableWeekStatus>(TimetableWeekUnavailable())),
    );
    await tester.pumpAndSettle();

    expect(find.text("Your timetable isn't available yet."), findsOneWidget);
  });

  testWidgets('renders a section per day with its periods and any exam overlay', (tester) async {
    await tester.pumpWidget(
      _screenScope(
        AsyncData<TimetableWeekStatus>(TimetableWeekReady(_cached(stale: false))),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(TimetableDaySection), findsNWidgets(2));
    expect(find.text('1'), findsWidgets); // period numbers
    expect(find.text('2'), findsOneWidget);
    expect(find.textContaining('Midterm Mathematics'), findsOneWidget);
    expect(find.byType(StalenessBanner), findsNothing);
  });

  testWidgets('a cached week shows the staleness banner', (tester) async {
    await tester.pumpWidget(
      _screenScope(
        AsyncData<TimetableWeekStatus>(TimetableWeekReady(_cached(stale: true))),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(StalenessBanner), findsOneWidget);
  });

  testWidgets('the empty-week message shows when the week has no days', (tester) async {
    final empty = CachedValue(
      data: TimetableWeek(weekStart: _weekStart, days: const []),
      fetchedAt: DateTime(2026, 8, 24, 8),
      source: CacheSource.network,
    );
    await tester.pumpWidget(
      _screenScope(AsyncData<TimetableWeekStatus>(TimetableWeekReady(empty))),
    );
    await tester.pumpAndSettle();

    expect(find.text('No classes this week.'), findsOneWidget);
  });

  testWidgets('paging forward moves the visible week on by seven days', (tester) async {
    final container = ProviderContainer();
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: wrapWithLocalization(
          Builder(
            builder: (context) {
              return MaterialApp(
                theme: AppTheme.light,
                debugShowCheckedModeBanner: false,
                locale: context.locale,
                supportedLocales: context.supportedLocales,
                localizationsDelegates: context.localizationDelegates,
                home: const Scaffold(body: TimetableWeekNavigator()),
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final before = container.read(visibleWeekProvider);

    await tester.tap(find.byIcon(Icons.chevron_right));
    await tester.pumpAndSettle();

    expect(container.read(visibleWeekProvider), before.add(const Duration(days: 7)));
    // "This week" only appears once the view has moved off the current week.
    expect(find.text('This week'), findsOneWidget);
  });
}
