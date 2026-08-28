import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_version.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/application/timetable_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/timetable_week.dart';

CachedValue<T> _live<T>(T data) {
  return CachedValue(data: data, fetchedAt: DateTime(2026, 8, 24), source: CacheSource.network);
}

/// Holds [timetableWeekProvider] (and its transitive `autoDispose` dependencies) alive for the
/// rest of the test, so a bare `container.read` after an `await` doesn't observe a disposed-and-
/// rebuilt provider mid-flight — the same guard `today_grades_provider_test.dart` uses.
void _keepAlive(ProviderContainer container) {
  container.listen(timetableWeekProvider, (previous, next) {}, fireImmediately: true);
}

/// Pins [visibleWeekProvider] to a fixed Monday so week-window assertions don't depend on the
/// day the test happens to run.
class _FixedWeek extends VisibleWeekNotifier {
  _FixedWeek(this._value);

  final DateTime _value;

  @override
  DateTime build() => _value;
}

/// Monday 2026-08-24.
final _weekStart = DateTime(2026, 8, 24);

TimetableSlot _slot({required String classId, required int weekday, required int period}) {
  final now = DateTime(2026, 1, 1);
  return TimetableSlot(
    id: 'slot-$classId-$weekday-$period',
    schoolId: 'school-1',
    timetableVersionId: 'version-1',
    classId: classId,
    teacherId: 'teacher-1',
    roomId: 'room-1',
    weekday: weekday,
    period: period,
    createdAt: now,
    updatedAt: now,
  );
}

/// Built through `fromJson` rather than the constructor so the test doesn't have to name the
/// generated `Status*` enum for `status`, whose number `swagger_parser` assigns document-wide.
Exam _exam({
  required String id,
  required DateTime startsAt,
  String status = 'scheduled',
  String classId = 'class-1',
}) {
  return Exam.fromJson({
    'id': id,
    'school_id': 'school-1',
    'class_id': classId,
    'created_by_user_id': 'user-1',
    'last_edited_by_user_id': 'user-1',
    'title': 'Exam $id',
    'description': null,
    'status': status,
    'starts_at': startsAt.toUtc().toIso8601String(),
    'ends_at': startsAt.add(const Duration(hours: 1)).toUtc().toIso8601String(),
    'max_score': 100,
    'room_id': 'room-1',
    'weight': 1,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

TimetableVersion _approvedVersion() {
  return TimetableVersion.fromJson({
    'id': 'version-1',
    'school_id': 'school-1',
    'academic_year_id': 'year-1',
    'term_id': 'term-1',
    'name': 'Term 1 Weekly Schedule',
    'status': 'approved',
    'submitted_at': null,
    'submitted_by_user_id': null,
    'approved_at': null,
    'approved_by_user_id': null,
    'rejected_reason': null,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

void main() {
  group('mondayOfWeek', () {
    test('returns the Monday midnight of the containing ISO week', () {
      // 2026-08-27 is a Thursday.
      expect(mondayOfWeek(DateTime(2026, 8, 27, 15, 30)), DateTime(2026, 8, 24));
    });

    test('is idempotent on a Monday', () {
      expect(mondayOfWeek(DateTime(2026, 8, 24)), DateTime(2026, 8, 24));
    });
  });

  group('assembleTimetableWeek', () {
    test('keeps only slots for the enrolled classes, one day section per weekday with content', () {
      final week = assembleTimetableWeek(
        weekStart: _weekStart,
        slots: [
          _slot(classId: 'class-1', weekday: 1, period: 2),
          _slot(classId: 'class-1', weekday: 1, period: 1),
          _slot(classId: 'class-2', weekday: 3, period: 1),
          _slot(classId: 'not-mine', weekday: 2, period: 1),
        ],
        exams: const [],
        enrolledClassIds: {'class-1', 'class-2'},
      );

      expect(week.days.map((d) => d.weekday), [1, 3]);
      // Monday's two periods come back sorted by period number.
      expect(week.days.first.date, DateTime(2026, 8, 24));
      expect(week.days.first.slots.map((s) => s.period), [1, 2]);
      // Wednesday maps to Monday + 2 days.
      expect(week.days[1].date, DateTime(2026, 8, 26));
    });

    test('overlays only exams that start inside the week and are not cancelled', () {
      final week = assembleTimetableWeek(
        weekStart: _weekStart,
        slots: const [],
        exams: [
          _exam(id: 'in-week', startsAt: DateTime(2026, 8, 26, 9)),
          _exam(id: 'cancelled', startsAt: DateTime(2026, 8, 26, 9), status: 'cancelled'),
          _exam(id: 'previous-week', startsAt: DateTime(2026, 8, 23, 9)),
          _exam(id: 'next-week', startsAt: DateTime(2026, 8, 31, 9)),
        ],
        enrolledClassIds: {'class-1'},
      );

      expect(week.days, hasLength(1));
      expect(week.days.single.weekday, 3);
      expect(week.days.single.exams.map((e) => e.id), ['in-week']);
    });

    test('sorts a day\'s exams by start time', () {
      final week = assembleTimetableWeek(
        weekStart: _weekStart,
        slots: const [],
        exams: [
          _exam(id: 'later', startsAt: DateTime(2026, 8, 25, 13)),
          _exam(id: 'earlier', startsAt: DateTime(2026, 8, 25, 9)),
        ],
        enrolledClassIds: {'class-1'},
      );

      expect(week.days.single.exams.map((e) => e.id), ['earlier', 'later']);
    });

    test('is empty when nothing falls in the week', () {
      final week = assembleTimetableWeek(
        weekStart: _weekStart,
        slots: const [],
        exams: const [],
        enrolledClassIds: {'class-1'},
      );

      expect(week.isEmpty, isTrue);
    });
  });

  group('timetableWeekProvider', () {
    test('is unavailable when the enrolled-class context is unresolved', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final status = container.read(timetableWeekProvider);

      expect(status, isA<AsyncData<TimetableWeekStatus>>());
      expect(
        (status as AsyncData<TimetableWeekStatus>).value,
        isA<TimetableWeekUnavailable>(),
      );
    });

    test('is unavailable when the term has no approved timetable version', () async {
      final container = ProviderContainer(
        overrides: [
          currentEnrolledClassIdsProvider.overrideWithValue(const ['class-1']),
          approvedTimetableVersionProvider.overrideWith((ref) async => null),
        ],
      );
      addTearDown(container.dispose);
      _keepAlive(container);

      await container.read(approvedTimetableVersionProvider.future);
      final status = container.read(timetableWeekProvider);

      expect(
        (status as AsyncData<TimetableWeekStatus>).value,
        isA<TimetableWeekUnavailable>(),
      );
    });

    test('assembles a ready week once the version, slots and exams resolve', () async {
      final container = ProviderContainer(
        overrides: [
          currentEnrolledClassIdsProvider.overrideWithValue(const ['class-1']),
          visibleWeekProvider.overrideWith(() => _FixedWeek(_weekStart)),
          approvedTimetableVersionProvider.overrideWith((ref) async => _approvedVersion()),
          timetableSlotsProvider.overrideWith(
            (ref, versionId) =>
                Stream.value(_live([_slot(classId: 'class-1', weekday: 1, period: 1)])),
          ),
          weekExamsProvider.overrideWith(
            (ref) => Stream.value(_live([_exam(id: 'e1', startsAt: DateTime(2026, 8, 25, 9))])),
          ),
        ],
      );
      addTearDown(container.dispose);
      _keepAlive(container);

      final version = await container.read(approvedTimetableVersionProvider.future);
      await container.read(timetableSlotsProvider(version!.id).future);
      await container.read(weekExamsProvider.future);

      final status = container.read(timetableWeekProvider);
      final ready = (status as AsyncData<TimetableWeekStatus>).value;
      expect(ready, isA<TimetableWeekReady>());
      final week = (ready as TimetableWeekReady).value.data;
      expect(week.days.map((d) => d.weekday), [1, 2]);
      expect(week.days.first.slots.single.period, 1);
      expect(week.days[1].exams.single.id, 'e1');
    });
  });
}
