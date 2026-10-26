import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
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

  group('grade sections', () {
    TimetableSlot inSection(
      String sectionId, {
      int weekday = 1,
      int period = 1,
      String classId = 'class-1',
      String? sectionName,
      String? grade = 'Grade 10',
    }) {
      return scheduleSlot(
        weekday: weekday,
        period: period,
        classId: classId,
        sectionId: sectionId,
        sectionName: sectionName ?? sectionId.toUpperCase(),
        gradeLevelName: grade,
      );
    }

    test('a slot cached before sections existed parses with no section', () {
      // The offline cache stores slots as JSON from before the section columns shipped.
      final slot = TimetableSlot.fromJson({
        'id': 'slot-1',
        'school_id': 'school-1',
        'timetable_version_id': 'version-1',
        'class_id': 'class-1',
        'teacher_id': 'teacher-1',
        'room_id': 'room-1',
        'weekday': 1,
        'period': 1,
        'created_at': '2026-01-01T00:00:00.000Z',
        'updated_at': '2026-01-01T00:00:00.000Z',
      });

      expect(slot.sectionId, isNull);
      expect(slot.sectionName, isNull);
      expect(slot.gradeLevelName, isNull);
      expect(scheduleSectionOf(slot), isNull);
    });

    test('a slot parses with a room id, a null room id, or none at all', () {
      // Rooms left the timetable: older cached JSON still carries a room id, newer rows a null.
      Map<String, Object?> json(Map<String, Object?> room) => {
        'id': 'slot-1',
        'school_id': 'school-1',
        'timetable_version_id': 'version-1',
        'class_id': 'class-1',
        'teacher_id': 'teacher-1',
        ...room,
        'weekday': 1,
        'period': 1,
        'created_at': '2026-01-01T00:00:00.000Z',
        'updated_at': '2026-01-01T00:00:00.000Z',
      };

      expect(TimetableSlot.fromJson(json({'room_id': 'room-1'})).roomId, 'room-1');
      expect(TimetableSlot.fromJson(json({'room_id': null})).roomId, isNull);
      expect(TimetableSlot.fromJson(json({})).roomId, isNull);
    });

    test('a slot round-trips its section through JSON', () {
      final slot = TimetableSlot.fromJson(
        inSection('sec-c', sectionName: 'C').toJson(),
      );

      final section = scheduleSectionOf(slot)!;
      expect(section.id, 'sec-c');
      expect(section.sectionName, 'C');
      expect(section.gradeLevelName, 'Grade 10');
    });

    test('a section without a usable name is no section', () {
      expect(scheduleSectionOf(inSection('sec-x', sectionName: '  ')), isNull);
      expect(
        scheduleSectionOf(inSection('sec-c', grade: ' '))!.gradeLevelName,
        isNull,
      );
    });

    test('lists distinct sections by grade, then section, naturally', () {
      final sections = scheduleSections([
        inSection('b10', sectionName: 'B'),
        inSection('a9', sectionName: 'A', grade: 'Grade 9'),
        inSection('a10', sectionName: 'A'),
        inSection('b10', sectionName: 'B', period: 2),
        inSection('loose', sectionName: 'Z', grade: null),
        scheduleSlot(weekday: 1, period: 3),
      ]);

      expect(sections.map((s) => s.id), ['a9', 'a10', 'b10', 'loose']);
    });

    test('a student\'s section is the one most of their lessons are in', () {
      final section = predominantSection([
        inSection('c', period: 1),
        inSection('elective', sectionName: 'A', period: 2),
        inSection('c', period: 3),
        scheduleSlot(weekday: 2, period: 1),
      ]);

      expect(section?.id, 'c');
    });

    test('a tie goes to the first section in display order', () {
      final section = predominantSection([
        inSection('d', period: 1),
        inSection('b', period: 2),
      ]);

      expect(section?.id, 'b');
    });

    test('no section when none of the lessons carries one', () {
      expect(predominantSection([scheduleSlot(weekday: 1, period: 1)]), isNull);
      expect(predominantSection(const []), isNull);
    });

    test('a filter outside the schedule\'s sections shows every section', () {
      final sections = scheduleSections([inSection('c')]);

      expect(resolveSectionFilter(sections, 'c'), 'c');
      expect(resolveSectionFilter(sections, 'gone'), isNull);
      expect(resolveSectionFilter(sections, null), isNull);
    });

    test('narrows slots to one section, or keeps them all', () {
      final slots = [
        inSection('c', period: 1),
        inSection('d', period: 2),
        scheduleSlot(weekday: 1, period: 3),
      ];

      expect(slotsForSection(slots, 'd').map((s) => s.period), [2]);
      expect(slotsForSection(slots, null), hasLength(3));
    });
  });
}
