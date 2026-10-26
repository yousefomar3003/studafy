import 'package:studafy_mobile/src/core/api/generated/models/timetable_settings.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_version.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';

/// Monday 2026-08-24 — a fixed "now" so day pre-selection doesn't depend on when the test runs.
final scheduleMonday = DateTime(2026, 8, 24, 9);

/// A lesson in section [sectionId] — "Section [sectionName]" of [gradeLevelName] — when given.
TimetableSlot scheduleSlot({
  required int weekday,
  required int period,
  String classId = 'class-1',
  String teacherId = 'teacher-1',
  String? roomId,
  String? sectionId,
  String? sectionName,
  String? gradeLevelName,
}) {
  final at = DateTime(2026, 1, 1);
  return TimetableSlot(
    id: 'slot-$classId-$weekday-$period',
    schoolId: 'school-1',
    timetableVersionId: 'version-1',
    classId: classId,
    teacherId: teacherId,
    roomId: roomId,
    sectionId: sectionId,
    sectionName: sectionName,
    gradeLevelName: gradeLevelName,
    weekday: weekday,
    period: period,
    createdAt: at,
    updatedAt: at,
  );
}

/// Built through `fromJson` so the test needn't name the generated `Status*` enum.
TimetableVersion approvedScheduleVersion({String id = 'version-1'}) {
  return TimetableVersion.fromJson({
    'id': id,
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

TimetableSettings scheduleSettings({
  List<int> schoolDays = const [7, 1, 2, 3, 4],
}) {
  return TimetableSettings(schoolDays: schoolDays, periodsPerDay: 8);
}

CachedValue<T> liveValue<T>(T data) {
  return CachedValue(
    data: data,
    fetchedAt: DateTime(2026, 8, 24),
    source: CacheSource.network,
  );
}

CachedValue<T> cachedValue<T>(T data) {
  return CachedValue(
    data: data,
    fetchedAt: DateTime(2026, 8, 23),
    source: CacheSource.cache,
  );
}
