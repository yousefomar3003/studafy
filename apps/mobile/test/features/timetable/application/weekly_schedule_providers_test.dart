import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override, ProviderListenable;
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_settings.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_version.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/timetable/application/weekly_schedule_providers.dart';
import 'package:studafy_mobile/src/features/timetable/domain/weekly_schedule.dart';

import '../support.dart';

/// Seed-shaped data: SCI101-A (Layla) meets Monday and Wednesday period 1; MATH101-A (Hassan)
/// meets Monday period 2 and Tuesday period 1.
final _slots = [
  scheduleSlot(weekday: 1, period: 1, classId: 'sci', teacherId: 'layla'),
  scheduleSlot(weekday: 1, period: 2, classId: 'math', teacherId: 'hassan'),
  scheduleSlot(weekday: 2, period: 1, classId: 'math', teacherId: 'hassan'),
  scheduleSlot(weekday: 3, period: 1, classId: 'sci', teacherId: 'layla'),
];

List<Override> _dataOverrides({
  TimetableVersion? version,
  bool noVersion = false,
  CachedValue<List<TimetableSlot>>? slots,
  Stream<CachedValue<TimetableSettings>>? settings,
}) {
  return [
    approvedTimetableVersionProvider.overrideWith(
      (ref) async => noVersion ? null : (version ?? approvedScheduleVersion()),
    ),
    timetableSlotsProvider.overrideWith(
      (ref, versionId) => Stream.value(slots ?? liveValue(_slots)),
    ),
    timetableSettingsProvider.overrideWith(
      (ref) => settings ?? Stream.value(liveValue(scheduleSettings())),
    ),
  ];
}

ProviderContainer _studentContainer({
  List<String> classIds = const ['sci'],
  List<Override> data = const [],
}) {
  final container = ProviderContainer(
    overrides: [
      currentStudentSelfProvider.overrideWith((ref) async => null),
      currentEnrolledClassIdsProvider.overrideWithValue(classIds),
      ...data,
    ],
    retry: (_, _) => null,
  );
  addTearDown(container.dispose);
  return container;
}

ProviderContainer _teacherContainer({
  String teacherId = 'layla',
  List<Override> data = const [],
}) {
  final container = ProviderContainer(
    overrides: [
      teacherIdProvider.overrideWith((ref) async => teacherId),
      ...data,
    ],
    retry: (_, _) => null,
  );
  addTearDown(container.dispose);
  return container;
}

/// Keeps [provider] (and its autoDispose dependencies) alive, then lets every override settle.
Future<WeeklyScheduleStatus> _settle(
  ProviderContainer container,
  ProviderListenable<AsyncValue<WeeklyScheduleStatus>> provider,
) async {
  container.listen(provider, (previous, next) {}, fireImmediately: true);
  for (var i = 0; i < 10 && container.read(provider).isLoading; i++) {
    await Future<void>.delayed(Duration.zero);
  }
  return container.read(provider).requireValue;
}

WeeklySchedule _ready(WeeklyScheduleStatus status) {
  expect(status, isA<WeeklyScheduleReady>());
  return (status as WeeklyScheduleReady).value.data;
}

void main() {
  group('studentWeeklyScheduleProvider', () {
    test(
      'shows only the enrolled classes\' lessons over the school week',
      () async {
        final container = _studentContainer(data: _dataOverrides());

        final schedule = _ready(
          await _settle(container, studentWeeklyScheduleProvider),
        );

        expect(schedule.days, [7, 1, 2, 3, 4]);
        expect(schedule.lessonCount, 2);
        expect(schedule.slotsFor(1).single.classId, 'sci');
        expect(schedule.slotsFor(2), isEmpty);
        expect(schedule.slotsFor(3).single.classId, 'sci');
      },
    );

    test('follows the school\'s configured week', () async {
      final container = _studentContainer(
        data: _dataOverrides(
          settings: Stream.value(
            liveValue(scheduleSettings(schoolDays: const [1, 2, 3, 4, 5])),
          ),
        ),
      );

      final schedule = _ready(
        await _settle(container, studentWeeklyScheduleProvider),
      );

      expect(schedule.days, [1, 2, 3, 4, 5]);
    });

    test(
      'falls back to the default week when the settings cannot be loaded',
      () async {
        final container = _studentContainer(
          data: _dataOverrides(settings: Stream.error(Exception('offline'))),
        );

        final schedule = _ready(
          await _settle(container, studentWeeklyScheduleProvider),
        );

        expect(schedule.days, defaultSchoolDays);
        expect(schedule.lessonCount, 2);
      },
    );

    test('is unavailable with no enrolled classes', () async {
      final container = _studentContainer(
        classIds: const [],
        data: _dataOverrides(),
      );

      expect(
        await _settle(container, studentWeeklyScheduleProvider),
        isA<WeeklyScheduleUnavailable>(),
      );
    });

    test('is unavailable when the term has no approved timetable', () async {
      final container = _studentContainer(
        data: _dataOverrides(noVersion: true),
      );

      expect(
        await _settle(container, studentWeeklyScheduleProvider),
        isA<WeeklyScheduleUnavailable>(),
      );
    });

    test('cached slots mark the schedule stale', () async {
      final container = _studentContainer(
        data: _dataOverrides(slots: cachedValue(_slots)),
      );

      final status = await _settle(container, studentWeeklyScheduleProvider);

      expect((status as WeeklyScheduleReady).value.isStale, isTrue);
    });
  });

  group('teacherWeeklyScheduleProvider', () {
    test('shows every lesson the signed-in teacher teaches', () async {
      final container = _teacherContainer(
        teacherId: 'hassan',
        data: _dataOverrides(),
      );

      final schedule = _ready(
        await _settle(container, teacherWeeklyScheduleProvider),
      );

      expect(schedule.lessonCount, 2);
      expect(schedule.slotsFor(1).single.period, 2);
      expect(schedule.slotsFor(2).single.classId, 'math');
      expect(schedule.slotsFor(3), isEmpty);
    });

    test('a teacher with no approved lessons gets an empty schedule', () async {
      final container = _teacherContainer(
        teacherId: 'nobody',
        data: _dataOverrides(),
      );

      final schedule = _ready(
        await _settle(container, teacherWeeklyScheduleProvider),
      );

      expect(schedule.isEmpty, isTrue);
    });
  });
}
