import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/parent/domain/child_timetable.dart';

import '../support.dart';

void main() {
  test('parses slots with optional course / teacher, ignoring any room', () {
    final timetable = childTimetableFixture(
      slots: [
        // The endpoint may still send a room object or null; both parse and neither is kept.
        childTimetableSlotJson(id: 's1'),
        childTimetableSlotJson(
          id: 's2',
          courseName: null,
          teacherName: null,
          roomName: null,
        ),
      ],
    );

    expect(timetable.isPublished, isTrue);
    expect(timetable.settings!.schoolDays, [7, 1, 2, 3, 4]);
    final [full, bare] = timetable.slots;
    expect(full.courseName, 'Science');
    expect(full.teacherName, 'Rana Haddad');
    expect(bare.classCode, 'SCI-7A');
    expect(bare.courseName, isNull);
    expect(bare.teacherId, isNull);
  });

  test('no approved version: unpublished, no slots', () {
    final timetable = childTimetableFixture(published: false);
    expect(timetable.isPublished, isFalse);
    expect(timetable.slots, isEmpty);
  });

  test(
    'adapts to the shared weekly schedule: school days, per-day order, labels',
    () {
      final adapted = childWeeklySchedule(
        childTimetableFixture(
          schoolDays: const [7, 1, 2],
          slots: [
            childTimetableSlotJson(id: 'late', weekday: 7, period: 3),
            childTimetableSlotJson(
              id: 'early',
              weekday: 7,
              period: 1,
              courseName: null,
            ),
            // A Friday lesson outside the school week still shows, on an appended day.
            childTimetableSlotJson(id: 'fri', weekday: 5, period: 2),
          ],
        ),
      );

      expect(adapted.schedule.days, [7, 1, 2, 5]);
      expect(adapted.schedule.slotsFor(7).map((s) => s.id), ['early', 'late']);
      expect(adapted.schedule.lessonCount, 3);
      expect(adapted.labels['early']!.title, 'SCI-7A');
      expect(adapted.labels['late']!.title, 'Science');
      expect(adapted.labels['late']!.teacher, 'Rana Haddad');
      expect(adapted.schedule.slotsFor(7).first.roomId, isNull);
    },
  );
}
