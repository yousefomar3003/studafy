import '../../../core/api/generated/models/timetable_settings.dart';
import '../../../core/api/generated/models/timetable_slot.dart';
import '../../timetable/domain/weekly_schedule.dart';

/// One lesson of a linked child's weekly timetable, with every display label already resolved
/// server-side (`GET /api/reports/children/{studentId}/timetable`) — a parent session cannot
/// resolve class / course / teacher names through the academics endpoints the student
/// and teacher schedules use. The endpoint may still send a `room` (object or null); it is
/// ignored, since lessons no longer show a room.
class ChildTimetableSlot {
  const ChildTimetableSlot({
    required this.id,
    required this.weekday,
    required this.period,
    required this.classId,
    required this.classCode,
    this.courseName,
    this.teacherId,
    this.teacherName,
  });

  factory ChildTimetableSlot.fromJson(Map<String, Object?> json) {
    final klass = _mapOrNull(json['class'])!;
    final course = _mapOrNull(json['course']);
    final teacher = _mapOrNull(json['teacher']);
    return ChildTimetableSlot(
      id: json['id']! as String,
      weekday: (json['weekday']! as num).toInt(),
      period: (json['period']! as num).toInt(),
      classId: klass['id']! as String,
      classCode: (klass['code'] as String?) ?? '',
      courseName: course?['name'] as String?,
      teacherId: teacher?['id'] as String?,
      teacherName: teacher?['name'] as String?,
    );
  }

  final String id;
  final int weekday;
  final int period;
  final String classId;
  final String classCode;
  final String? courseName;
  final String? teacherId;
  final String? teacherName;
}

/// A linked child's approved weekly timetable for the current term.
class ChildTimetable {
  const ChildTimetable({
    required this.studentId,
    required this.termId,
    required this.timetableVersionId,
    required this.settings,
    required this.slots,
  });

  factory ChildTimetable.fromJson(Map<String, Object?> json) {
    final settings = _mapOrNull(json['settings']);
    return ChildTimetable(
      studentId: json['student_id']! as String,
      termId: json['term_id'] as String?,
      timetableVersionId: json['timetable_version_id'] as String?,
      settings: settings == null ? null : TimetableSettings.fromJson(settings),
      slots: [
        for (final entry in (json['slots'] as List<Object?>?) ?? const [])
          ChildTimetableSlot.fromJson(_mapOrNull(entry)!),
      ],
    );
  }

  final String studentId;

  /// Null when the school has no current term.
  final String? termId;

  /// Null when the current term has no approved timetable yet.
  final String? timetableVersionId;
  final TimetableSettings? settings;
  final List<ChildTimetableSlot> slots;

  bool get isPublished => timetableVersionId != null;
}

/// [timetable] adapted to the shared weekly-schedule model, so the parent view renders through
/// the same `WeeklyScheduleView` as the student and teacher schedules. The slots become
/// [TimetableSlot]s (a missing teacher id as an empty string, no room — nothing looks them up, since
/// [ChildWeeklySchedule.labels] carries every name the lesson cards show).
ChildWeeklySchedule childWeeklySchedule(ChildTimetable timetable) {
  final epoch = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
  final slots = [
    for (final slot in timetable.slots)
      TimetableSlot(
        id: slot.id,
        schoolId: '',
        timetableVersionId: timetable.timetableVersionId ?? '',
        classId: slot.classId,
        teacherId: slot.teacherId ?? '',
        roomId: null,
        // The child-timetable endpoint (`reports/child-timetable.ts`) doesn't carry sections.
        sectionId: null,
        sectionName: null,
        gradeLevelName: null,
        weekday: slot.weekday,
        period: slot.period,
        createdAt: epoch,
        updatedAt: epoch,
      ),
  ];
  return (
    schedule: buildWeeklySchedule(schoolDays: timetable.settings?.schoolDays, slots: slots),
    labels: {
      for (final slot in timetable.slots)
        slot.id: (
          title: slot.courseName ?? slot.classCode,
          classCode: slot.classCode,
          teacher: slot.teacherName,
        ),
    },
  );
}

/// A [WeeklySchedule] plus each slot's pre-resolved labels, keyed by slot id.
typedef ChildWeeklySchedule = ({WeeklySchedule schedule, Map<String, LessonLabels> labels});

Map<String, Object?>? _mapOrNull(Object? raw) =>
    raw == null ? null : Map<String, Object?>.from(raw as Map);
