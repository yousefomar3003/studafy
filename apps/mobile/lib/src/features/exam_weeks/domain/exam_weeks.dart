/// Domain model for exam weeks: a student's exam timetable
/// (`GET /api/academics/students/{studentId}/exam-timetable`; OpenAPI schema `StudentExamTimetable`)
/// and a teacher's invigilation duties (`GET /api/academics/me/invigilation-duties`;
/// `InvigilationDutyList`).
///
/// Dates and times are the school's wall clock: an exam on 2027-01-10 from 09:00 is at 09:00 in
/// the school's timezone ([timezone], e.g. Asia/Amman), whatever the phone's own timezone, so they
/// are kept and shown as sent, never converted.
///
/// Hand-written like `graduation_requirements.dart` and parsed defensively: a missing field, a
/// malformed date or an unknown period kind never throws, so an older app keeps working when the
/// API adds to it.
library;

/// The kind of exam period. [unknown] is a value a newer API might send: shown neutrally.
enum ExamPeriodKind {
  midterm,
  finalExams,
  monthly,
  mock,
  other,
  unknown;

  static ExamPeriodKind fromWire(Object? value) => switch (value) {
    'midterm' => midterm,
    'final' => finalExams,
    'monthly' => monthly,
    'mock' => mock,
    'other' => other,
    _ => unknown,
  };
}

/// A school calendar day (YYYY-MM-DD) as a date-only [DateTime]; null when malformed.
DateTime? parseSchoolDay(Object? value) {
  if (value is! String) return null;
  final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (match == null) return null;
  final day = DateTime(
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
  );
  // DateTime normalises 2027-02-31 to March: reject rather than show the wrong day.
  return day.month == int.parse(match.group(2)!) ? day : null;
}

/// An HH:MM wall-clock time as sent (seconds dropped); null when malformed.
String? parseSchoolTime(Object? value) {
  if (value is! String) return null;
  final match = RegExp(r'^([01]\d|2[0-3]):([0-5]\d)').firstMatch(value);
  return match?.group(0);
}

class ExamRoom {
  const ExamRoom({
    required this.name,
    required this.code,
    this.building,
    this.floor,
  });

  static ExamRoom? fromJson(Object? json) {
    final map = _map(json);
    final name = map['name'];
    if (name is! String || name.isEmpty) return null;
    return ExamRoom(
      name: name,
      code: map['code'] as String? ?? '',
      building: map['building'] as String?,
      floor: map['floor'] as String?,
    );
  }

  final String name;
  final String code;
  final String? building;
  final String? floor;
}

/// One exam on the student's timetable, with their room and seat once seated.
class StudentExam {
  const StudentExam({
    required this.id,
    required this.subject,
    required this.date,
    required this.startsAt,
    required this.endsAt,
    this.room,
    this.seatNumber,
  });

  static StudentExam? fromJson(Map<String, Object?> json) {
    final date = parseSchoolDay(json['exam_date']);
    final startsAt = parseSchoolTime(json['starts_at']);
    final endsAt = parseSchoolTime(json['ends_at']);
    if (date == null || startsAt == null || endsAt == null) return null;
    return StudentExam(
      id: json['id'] as String? ?? '',
      subject: _map(json['subject'])['name'] as String? ?? '',
      date: date,
      startsAt: startsAt,
      endsAt: endsAt,
      room: ExamRoom.fromJson(json['room']),
      seatNumber: (json['seat_number'] as num?)?.toInt(),
    );
  }

  final String id;
  final String subject;

  /// The school calendar day.
  final DateTime date;

  /// HH:MM, the school's wall clock.
  final String startsAt;
  final String endsAt;

  /// Null until the school seats the student.
  final ExamRoom? room;
  final int? seatNumber;
}

class StudentExamPeriod {
  const StudentExamPeriod({
    required this.name,
    required this.kind,
    required this.startsOn,
    required this.endsOn,
    required this.exams,
  });

  factory StudentExamPeriod.fromJson(Map<String, Object?> json) =>
      StudentExamPeriod(
        name: json['name'] as String? ?? '',
        kind: ExamPeriodKind.fromWire(json['kind']),
        startsOn: parseSchoolDay(json['starts_on']),
        endsOn: parseSchoolDay(json['ends_on']),
        exams: [
          for (final slot in _list(json['slots']))
            if (StudentExam.fromJson(slot) case final StudentExam exam) exam,
        ]..sort(_byDateAndTime),
      );

  final String name;
  final ExamPeriodKind kind;
  final DateTime? startsOn;
  final DateTime? endsOn;
  final List<StudentExam> exams;
}

class StudentExamTimetable {
  const StudentExamTimetable({required this.timezone, required this.periods});

  factory StudentExamTimetable.fromJson(Object? body) {
    final json = _map(body);
    return StudentExamTimetable(
      timezone: json['timezone'] as String?,
      periods: [
        for (final period in _list(json['periods']))
          StudentExamPeriod.fromJson(period),
      ],
    );
  }

  /// The school's IANA timezone; null from an older server.
  final String? timezone;
  final List<StudentExamPeriod> periods;

  bool get isEmpty => periods.every((period) => period.exams.isEmpty);
}

/// One room a teacher invigilates for one exam.
class InvigilationDuty {
  const InvigilationDuty({
    required this.periodName,
    required this.subject,
    required this.gradeLevel,
    required this.sections,
    required this.date,
    required this.startsAt,
    required this.endsAt,
    required this.room,
  });

  static InvigilationDuty? fromJson(Map<String, Object?> json) {
    final date = parseSchoolDay(json['exam_date']);
    final startsAt = parseSchoolTime(json['starts_at']);
    final endsAt = parseSchoolTime(json['ends_at']);
    final room = ExamRoom.fromJson(json['room']);
    if (date == null || startsAt == null || endsAt == null || room == null) {
      return null;
    }
    return InvigilationDuty(
      periodName: _map(json['period'])['name'] as String? ?? '',
      subject: _map(json['subject'])['name'] as String? ?? '',
      gradeLevel: _map(json['grade_level'])['name'] as String? ?? '',
      sections: [
        for (final section in _list(json['sections']))
          if (section['name'] case final String name) name,
      ],
      date: date,
      startsAt: startsAt,
      endsAt: endsAt,
      room: room,
    );
  }

  final String periodName;
  final String subject;
  final String gradeLevel;
  final List<String> sections;
  final DateTime date;
  final String startsAt;
  final String endsAt;
  final ExamRoom room;
}

class InvigilationDuties {
  const InvigilationDuties({required this.timezone, required this.duties});

  factory InvigilationDuties.fromJson(Object? body) {
    final json = _map(body);
    return InvigilationDuties(
      timezone: json['timezone'] as String?,
      duties:
          [
            for (final duty in _list(json['duties']))
              if (InvigilationDuty.fromJson(duty)
                  case final InvigilationDuty parsed)
                parsed,
          ]..sort(
            (a, b) => a.date.compareTo(b.date) != 0
                ? a.date.compareTo(b.date)
                : a.startsAt.compareTo(b.startsAt),
          ),
    );
  }

  final String? timezone;
  final List<InvigilationDuty> duties;
}

/// Whether [day] is before [today] (both school calendar days): a past exam.
bool isPastDay(DateTime day, DateTime today) =>
    day.isBefore(DateTime(today.year, today.month, today.day));

int _byDateAndTime(StudentExam a, StudentExam b) {
  final byDate = a.date.compareTo(b.date);
  return byDate != 0 ? byDate : a.startsAt.compareTo(b.startsAt);
}

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final item in value)
      if (item is Map) Map<String, Object?>.from(item),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};
