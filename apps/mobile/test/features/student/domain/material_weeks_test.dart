import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart';
import 'package:studafy_mobile/src/features/student/domain/material_weeks.dart';

Material _material(String id, {int? week, int? day}) => Material.fromJson({
  'id': id,
  'school_id': 'school-1',
  'class_id': 'class-1',
  'uploaded_by_user_id': 'teacher-1',
  'last_edited_by_user_id': 'teacher-1',
  'title': id,
  'description': null,
  'storage_key': 'permanent/school-1/materials/$id.pdf',
  'original_file_name': '$id.pdf',
  'mime_type': 'application/pdf',
  'size_bytes': 1024,
  'checksum_sha256': null,
  'ai_visible': true,
  'ingest_status': 'ready',
  'ingest_error': null,
  'ingested_at': '2026-01-01T00:00:00.000Z',
  'week_number': week,
  'day_of_week': day,
  'created_at': '2026-01-01T00:00:00.000Z',
  'updated_at': '2026-01-01T00:00:00.000Z',
});

/// A Thursday-to-Thursday term at a Sunday-to-Thursday school: week 1 runs Sun 30 Aug – Sat 5 Sep.
MaterialWeekCalendar _sundaySchool() => MaterialWeekCalendar(
  termStartsOn: DateTime(2026, 9, 3),
  termEndsOn: DateTime(2026, 12, 17),
  teachingDays: const [7, 1, 2, 3, 4],
);

DateTime _d(int year, int month, int day) => DateTime.utc(year, month, day);

List<String> _ids(Iterable<Material> materials) => [for (final m in materials) m.id];

void main() {
  group('MaterialWeekCalendar', () {
    test('week 1 is the week containing the term start, starting on the first teaching day', () {
      final calendar = _sundaySchool();
      expect(calendar.weekStartDay, DateTime.sunday);
      expect(calendar.weekStart(1), _d(2026, 8, 30));
      expect(calendar.weekStart(3), _d(2026, 9, 13));
      expect(calendar.dateOf(3, DateTime.tuesday), _d(2026, 9, 15));
      expect(calendar.teachingRange(3), (_d(2026, 9, 13), _d(2026, 9, 17)));
    });

    test('numbers the weeks a date falls in, before, during and after the term', () {
      final calendar = _sundaySchool();
      expect(calendar.weekNumberOn(DateTime(2026, 8, 30)), 1);
      expect(calendar.weekNumberOn(DateTime(2026, 9, 5, 23, 59)), 1);
      expect(calendar.weekNumberOn(DateTime(2026, 9, 6)), 2);
      expect(calendar.weekNumberOn(DateTime(2026, 8, 29)), 0);
      expect(calendar.weekNumberOn(DateTime(2026, 12, 17)), 16);
      expect(calendar.weekCount, 16);
    });

    test('a Monday-first week (no teaching week known) numbers from the Monday', () {
      final calendar = MaterialWeekCalendar(
        termStartsOn: DateTime(2026, 9, 3),
        termEndsOn: DateTime(2026, 12, 17),
      );
      expect(calendar.teachingDays, allWeekdays);
      expect(calendar.weekStart(1), _d(2026, 8, 31));
      expect(calendar.teachingRange(2), (_d(2026, 9, 7), _d(2026, 9, 13)));
      // Sunday ends a Monday-first week rather than starting the next.
      expect(calendar.weekNumberOn(DateTime(2026, 9, 6)), 1);
      expect(calendar.weekCount, 16);
    });

    test('without term dates there are no dates, current week or term length', () {
      final calendar = MaterialWeekCalendar(teachingDays: const [7, 1, 2, 3, 4]);
      expect(calendar.weekStart(1), isNull);
      expect(calendar.dateOf(2, 1), isNull);
      expect(calendar.teachingRange(2), isNull);
      expect(calendar.weekNumberOn(DateTime(2026, 9, 6)), isNull);
      expect(calendar.weekCount, isNull);
    });

    test('caps the term length at the API bound', () {
      final calendar = MaterialWeekCalendar(
        termStartsOn: DateTime(2026, 1, 1),
        termEndsOn: DateTime(2028, 1, 1),
      );
      expect(calendar.weekCount, maxMaterialWeeks);
    });

    test('an empty teaching week falls back to all seven days', () {
      expect(MaterialWeekCalendar(teachingDays: const []).teachingDays, allWeekdays);
    });
  });

  group('groupMaterialsByWeek', () {
    test('orders weeks ascending, days in week order, then Unscheduled last', () {
      final sections = groupMaterialsByWeek([
        _material('w3-mon', week: 3, day: 1),
        _material('none-a'),
        _material('w1-thu', week: 1, day: 4),
        _material('w3-sun', week: 3, day: 7),
        _material('w1-sun', week: 1, day: 7),
        _material('none-b'),
      ], _sundaySchool());

      expect([for (final s in sections) s.key], ['week-1', 'week-3', 'unscheduled']);

      final week1 = sections[0];
      expect([for (final d in week1.days) d.dayOfWeek], [7, 4]);
      expect(week1.days.first.date, _d(2026, 8, 30));
      expect(week1.range, (_d(2026, 8, 30), _d(2026, 9, 3)));
      expect(week1.materialCount, 2);

      final week3 = sections[1];
      expect([for (final d in week3.days) d.dayOfWeek], [7, 1]);
      expect(week3.days.last.date, _d(2026, 9, 14));

      final unscheduled = sections[2];
      expect(unscheduled.isUnscheduled, isTrue);
      expect(unscheduled.days, isEmpty);
      expect(_ids(unscheduled.unscheduled), ['none-a', 'none-b']);
    });

    test('keeps the server order within a day', () {
      final sections = groupMaterialsByWeek([
        _material('newest', week: 2, day: 3),
        _material('other-day', week: 2, day: 1),
        _material('older', week: 2, day: 3),
      ], _sundaySchool());

      final wednesday = sections.single.days.firstWhere((d) => d.dayOfWeek == 3);
      expect(_ids(wednesday.materials), ['newest', 'older']);
    });

    test('a day outside the teaching week still gets its group, in week order', () {
      final sections = groupMaterialsByWeek([
        _material('fri', week: 2, day: 5),
        _material('sun', week: 2, day: 7),
        _material('sat', week: 2, day: 6),
      ], _sundaySchool());

      expect([for (final d in sections.single.days) d.dayOfWeek], [7, 5, 6]);
    });

    test('a half-placed or out-of-range row is listed as unscheduled, never dropped', () {
      final sections = groupMaterialsByWeek([
        _material('week-only', week: 2),
        _material('day-only', day: 2),
        _material('bad-day', week: 2, day: 9),
      ], _sundaySchool());

      expect(sections.single.isUnscheduled, isTrue);
      expect(_ids(sections.single.unscheduled), ['week-only', 'day-only', 'bad-day']);
    });

    test('groups by week without term dates, just without dates', () {
      final sections = groupMaterialsByWeek([
        _material('a', week: 4, day: 2),
      ], MaterialWeekCalendar());

      expect(sections.single.weekNumber, 4);
      expect(sections.single.range, isNull);
      expect(sections.single.days.single.date, isNull);
    });

    test('no materials, no sections', () {
      expect(groupMaterialsByWeek(const [], _sundaySchool()), isEmpty);
    });
  });

  group('defaultExpandedSectionKey', () {
    final calendar = _sundaySchool();
    // Tuesday of week 3.
    final today = DateTime(2026, 9, 15, 10);

    List<MaterialWeekSection> sectionsFor(List<int?> weeks) => groupMaterialsByWeek([
      for (final (i, week) in weeks.indexed)
        _material('m$i', week: week, day: week == null ? null : 1),
    ], calendar);

    test('expands the current week', () {
      expect(defaultExpandedSectionKey(sectionsFor([1, 3, 5, null]), calendar, today), 'week-3');
    });

    test('falls back to the latest earlier week when the current one is empty', () {
      expect(defaultExpandedSectionKey(sectionsFor([1, 2, 5, null]), calendar, today), 'week-2');
    });

    test('falls back to the first section when nothing is current or earlier', () {
      expect(defaultExpandedSectionKey(sectionsFor([5, 6]), calendar, today), 'week-5');
      // Every material uploaded before weeks existed: Unscheduled opens.
      expect(defaultExpandedSectionKey(sectionsFor([null]), calendar, today), 'unscheduled');
    });

    test('without term dates, the first section', () {
      final sections = groupMaterialsByWeek([
        _material('a', week: 2, day: 1),
        _material('b', week: 7, day: 1),
      ], MaterialWeekCalendar());
      expect(defaultExpandedSectionKey(sections, MaterialWeekCalendar(), today), 'week-2');
    });

    test('nothing to expand without sections', () {
      expect(defaultExpandedSectionKey(const [], calendar, today), isNull);
    });
  });
}
