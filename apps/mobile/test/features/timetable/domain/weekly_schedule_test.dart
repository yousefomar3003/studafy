import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/timetable/domain/weekly_schedule.dart';

import '../support.dart';

void main() {
  group('orderedSchoolDays', () {
    test('keeps the school\'s own display order (Sunday-first week)', () {
      expect(orderedSchoolDays(const [7, 1, 2, 3, 4]), [7, 1, 2, 3, 4]);
    });

    test('keeps a Monday-first week as given', () {
      expect(orderedSchoolDays(const [1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
    });

    test('drops duplicates and out-of-range weekdays without reordering', () {
      expect(orderedSchoolDays(const [6, 0, 1, 6, 8, 2]), [6, 1, 2]);
    });

    test('falls back to the API default week when missing or empty', () {
      expect(orderedSchoolDays(null), defaultSchoolDays);
      expect(orderedSchoolDays(const []), defaultSchoolDays);
      expect(orderedSchoolDays(const [0, 9]), defaultSchoolDays);
    });
  });

  group('initialScheduleDay', () {
    test('preselects today when it is a school day', () {
      // 2026-08-26 is a Wednesday.
      expect(
        initialScheduleDay(const [7, 1, 2, 3, 4], DateTime(2026, 8, 26)),
        3,
      );
    });

    test('preselects the first school day when today is not one', () {
      // 2026-08-28 is a Friday — outside a Sunday–Thursday week.
      expect(
        initialScheduleDay(const [7, 1, 2, 3, 4], DateTime(2026, 8, 28)),
        7,
      );
      expect(
        initialScheduleDay(const [1, 2, 3, 4, 5], DateTime(2026, 8, 29)),
        1,
      );
    });
  });

  group('slot filtering', () {
    final slots = [
      scheduleSlot(weekday: 1, period: 1, classId: 'sci', teacherId: 'layla'),
      scheduleSlot(weekday: 1, period: 2, classId: 'math', teacherId: 'hassan'),
      scheduleSlot(weekday: 3, period: 1, classId: 'sci', teacherId: 'layla'),
      scheduleSlot(weekday: 2, period: 4, classId: 'eng', teacherId: 'layla'),
    ];

    test(
      'a student sees only the slots of the classes they are enrolled in',
      () {
        final mine = slotsForClasses(slots, {'sci'});
        expect(mine.map((s) => s.id), ['slot-sci-1-1', 'slot-sci-3-1']);
      },
    );

    test('a student enrolled in nothing sees nothing', () {
      expect(slotsForClasses(slots, const {}), isEmpty);
    });

    test('a teacher sees every slot they teach, across classes', () {
      final mine = slotsForTeacher(slots, 'layla');
      expect(mine.map((s) => s.classId), ['sci', 'sci', 'eng']);
      expect(slotsForTeacher(slots, 'nobody'), isEmpty);
    });
  });

  group('buildWeeklySchedule', () {
    test(
      'lists every school day in order, with each day\'s lessons by period',
      () {
        final schedule = buildWeeklySchedule(
          schoolDays: const [7, 1, 2, 3, 4],
          slots: [
            scheduleSlot(weekday: 1, period: 3),
            scheduleSlot(weekday: 1, period: 1),
            scheduleSlot(weekday: 3, period: 2),
          ],
        );

        expect(schedule.days, [7, 1, 2, 3, 4]);
        expect(schedule.slotsFor(1).map((s) => s.period), [1, 3]);
        expect(schedule.slotsFor(7), isEmpty);
        expect(schedule.lessonCount, 3);
        expect(schedule.isEmpty, isFalse);
      },
    );

    test(
      'a lesson on a day outside the school week is appended, never hidden',
      () {
        final schedule = buildWeeklySchedule(
          schoolDays: const [7, 1, 2, 3, 4],
          slots: [
            scheduleSlot(weekday: 5, period: 1),
            scheduleSlot(weekday: 1, period: 1),
          ],
        );

        expect(schedule.days, [7, 1, 2, 3, 4, 5]);
        expect(schedule.slotsFor(5), hasLength(1));
      },
    );

    test('an empty selection is an empty schedule over the school week', () {
      final schedule = buildWeeklySchedule(schoolDays: null, slots: const []);

      expect(schedule.days, defaultSchoolDays);
      expect(schedule.isEmpty, isTrue);
    });
  });
}
