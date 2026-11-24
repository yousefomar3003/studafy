/// Domain model for a student's exam entries
/// (`GET /api/grading/students/{studentId}/external-exam-entries`; OpenAPI schema
/// `StudentExamEntry`): the external exam sessions the school entered the student for — IGCSE
/// May/June 2027 with their subjects, candidate number and dates.
///
/// Hand-written like `external_exam_results.dart` and parsed defensively: a missing field is null,
/// an unknown status is [ExamEntryStatus.unknown], and a malformed row is skipped, so an older app
/// keeps working when the API adds to the shape.
library;

/// Where an entry stands. The API sends a student only entries sent to the board; [unknown] is a
/// value a newer API might send, shown neutrally.
enum ExamEntryStatus {
  entered,
  withdrawn,
  unknown;

  static ExamEntryStatus parse(Object? value) => switch (value) {
    'entered' => entered,
    'withdrawn' => withdrawn,
    _ => unknown,
  };
}

/// One subject the student is entered for, with its tier and the board's code where set.
class ExamEntrySubject {
  const ExamEntrySubject({
    required this.name,
    required this.tier,
    required this.optionCode,
  });

  factory ExamEntrySubject.fromJson(Map<String, Object?> json) {
    final subject = json['subject'] is Map ? _map(json['subject']) : null;
    return ExamEntrySubject(
      name: subject?['name'] as String?,
      tier: _text(json['tier']),
      optionCode: _text(json['option_code']),
    );
  }

  /// Null when the school's subject could not be named.
  final String? name;
  final String? tier;
  final String? optionCode;
}

/// One exam session the student is entered for.
class StudentExamEntry {
  const StudentExamEntry({
    required this.id,
    required this.examName,
    required this.series,
    required this.candidateNumber,
    required this.status,
    required this.entryDeadline,
    required this.startsOn,
    required this.endsOn,
    required this.resultsDate,
    required this.subjects,
  });

  /// Null for a row without an id (never sent by the API; skipped by [parseStudentExamEntries]).
  static StudentExamEntry? fromJson(Map<String, Object?> json) {
    final id = json['id'];
    if (id is! String) return null;
    final exam = _map(json['exam']);
    final session = _map(json['session']);
    return StudentExamEntry(
      id: id,
      examName: exam['name'] as String? ?? '',
      series: session['series'] as String? ?? '',
      candidateNumber: _text(json['candidate_number']),
      status: ExamEntryStatus.parse(json['status']),
      entryDeadline: _date(session['entry_deadline']),
      startsOn: _date(session['starts_on']),
      endsOn: _date(session['ends_on']),
      resultsDate: _date(session['results_date']),
      subjects: [
        for (final subject in _list(json['subjects']))
          ExamEntrySubject.fromJson(subject),
      ],
    );
  }

  final String id;
  final String examName;

  /// The board's name for the session: "May/June 2027".
  final String series;
  final String? candidateNumber;
  final ExamEntryStatus status;
  final DateTime? entryDeadline;

  /// The first and last exam of the session.
  final DateTime? startsOn;
  final DateTime? endsOn;
  final DateTime? resultsDate;

  /// Empty for an exam entered as a whole (IELTS).
  final List<ExamEntrySubject> subjects;
}

/// The `entries` of the list response, latest session first as the API sends them.
List<StudentExamEntry> parseStudentExamEntries(Object? body) {
  final map = _map(body);
  return [
    for (final row in _list(map['entries'])) ?StudentExamEntry.fromJson(row),
  ];
}

List<Map<String, Object?>> _list(Object? value) => [
  if (value is List)
    for (final item in value)
      if (item is Map) Map<String, Object?>.from(item),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
