/// One student as seen by a teacher of one of their classes, from
/// `GET /api/academics/classes/{classId}/students/{studentId}/overview` (`StudentOverview`).
/// Hand-written like `mark_sheet.dart` and `report_comments.dart`: the screen reads a handful of
/// fields and owns its parsing, so a schema addition never needs a client regeneration.
library;

class StudentOverview {
  const StudentOverview({
    required this.classCode,
    required this.subjectName,
    required this.sectionName,
    required this.termName,
    required this.studentId,
    required this.firstName,
    required this.lastName,
    required this.preferredName,
    required this.admissionNumber,
    required this.enrolledAt,
    required this.marks,
    required this.marksUnavailable,
    required this.attendance,
    required this.homework,
    required this.comments,
    required this.records,
  });

  factory StudentOverview.fromJson(Map<String, Object?> json) {
    final klass = _map(json['class']);
    final student = _map(json['student']);
    return StudentOverview(
      classCode: klass['code'] as String? ?? '',
      subjectName: klass['subject_name'] as String? ?? '',
      sectionName: klass['section_name'] as String?,
      termName: klass['term_name'] as String? ?? '',
      studentId: student['id']! as String,
      firstName: student['first_name'] as String? ?? '',
      lastName: student['last_name'] as String? ?? '',
      preferredName: student['preferred_name'] as String?,
      admissionNumber: student['admission_number'] as String? ?? '',
      enrolledAt: DateTime.tryParse(student['enrolled_at'] as String? ?? ''),
      marks: json['marks'] is Map
          ? StudentMarks.fromJson(_map(json['marks']))
          : null,
      marksUnavailable: json['marks_unavailable'] as String?,
      attendance: StudentAttendance.fromJson(_map(json['attendance'])),
      homework: StudentHomework.fromJson(_map(json['homework'])),
      comments: StudentComments.fromJson(_map(json['report_comments'])),
      records: [
        for (final record in _list(json['records']))
          StudentRecordField(
            labelEn: record['label_en'] as String? ?? '',
            labelAr: record['label_ar'] as String? ?? '',
            valueEn: record['value_en'] as String? ?? '',
            valueAr: record['value_ar'] as String? ?? '',
          ),
      ],
    );
  }

  final String classCode;
  final String subjectName;
  final String? sectionName;
  final String termName;
  final String studentId;
  final String firstName;
  final String lastName;
  final String? preferredName;
  final String admissionNumber;
  final DateTime? enrolledAt;
  final StudentMarks? marks;

  /// Why [marks] is null: `no_section`, `not_configured` or `not_in_roster`.
  final String? marksUnavailable;
  final StudentAttendance attendance;
  final StudentHomework homework;
  final StudentComments comments;
  final List<StudentRecordField> records;

  String get fullName => '$firstName $lastName'.trim();
}

class StudentMarks {
  const StudentMarks({
    required this.gradingMethod,
    required this.resultFormat,
    required this.resultScaleMax,
    required this.exempt,
    required this.complete,
    required this.displayValue,
    required this.percentage,
    required this.gradeLabel,
    required this.passed,
    required this.termPercentage,
    required this.assessments,
  });

  factory StudentMarks.fromJson(Map<String, Object?> json) => StudentMarks(
    gradingMethod: json['grading_method'] as String? ?? 'weighted',
    resultFormat: json['result_format'] as String? ?? 'percentage',
    resultScaleMax: _num(json['result_scale_max']) ?? 100,
    exempt: json['exempt'] == true,
    complete: json['status'] == 'complete',
    displayValue: _num(json['display_value']),
    percentage:
        _num(json['percentage']) ?? _num(json['provisional_percentage']),
    gradeLabel: json['grade_label'] as String?,
    passed: json['passed'] as bool?,
    termPercentage: _num(json['term_percentage']),
    assessments: [
      for (final item in _list(json['assessments']))
        StudentAssessmentMark(
          name: item['name'] as String? ?? '',
          maxMarks: _num(item['max_marks']) ?? 0,
          status: item['status'] as String? ?? 'pending',
          score: _num(item['score']),
          descriptorLabel: item['descriptor_label'] as String?,
          date: DateTime.tryParse(item['assessment_date'] as String? ?? ''),
        ),
    ],
  );

  /// `weighted`, `total_points` or `descriptive` (no numbers at all).
  final String gradingMethod;

  /// `percentage`, `out_of` or `gpa` — how the grade shows results.
  final String resultFormat;
  final num resultScaleMax;
  final bool exempt;

  /// Every required mark is in; otherwise the figures are provisional.
  final bool complete;

  /// The result in [resultFormat].
  final num? displayValue;

  /// The (final or provisional) percentage.
  final num? percentage;
  final String? gradeLabel;
  final bool? passed;
  final num? termPercentage;
  final List<StudentAssessmentMark> assessments;

  bool get descriptive => gradingMethod == 'descriptive';
}

class StudentAssessmentMark {
  const StudentAssessmentMark({
    required this.name,
    required this.maxMarks,
    required this.status,
    required this.score,
    required this.descriptorLabel,
    required this.date,
  });

  final String name;
  final num maxMarks;

  /// `graded`, `absent`, `excused`, `not_applicable` or `pending`.
  final String status;
  final num? score;
  final String? descriptorLabel;
  final DateTime? date;
}

class StudentAttendance {
  const StudentAttendance({
    required this.sessions,
    required this.present,
    required this.absent,
    required this.late,
    required this.excused,
    required this.remote,
    required this.recent,
  });

  factory StudentAttendance.fromJson(Map<String, Object?> json) =>
      StudentAttendance(
        sessions: _int(json['sessions']),
        present: _int(json['present']),
        absent: _int(json['absent']),
        late: _int(json['late']),
        excused: _int(json['excused']),
        remote: _int(json['remote']),
        recent: [
          for (final item in _list(json['recent']))
            (
              date: DateTime.tryParse(item['session_date'] as String? ?? ''),
              late: item['status'] == 'late',
              minutesLate: _num(item['minutes_late'])?.toInt(),
            ),
        ],
      );

  final int sessions;
  final int present;
  final int absent;
  final int late;
  final int excused;
  final int remote;
  final List<({DateTime? date, bool late, int? minutesLate})> recent;
}

class StudentHomework {
  const StudentHomework({
    required this.total,
    required this.handedIn,
    required this.missing,
    required this.upcoming,
    required this.items,
  });

  factory StudentHomework.fromJson(Map<String, Object?> json) =>
      StudentHomework(
        total: _int(json['total']),
        handedIn: _int(json['handed_in']),
        missing: _int(json['missing']),
        upcoming: _int(json['upcoming']),
        items: [
          for (final item in _list(json['items']))
            (
              title: item['title'] as String? ?? '',
              dueAt: DateTime.tryParse(item['due_at'] as String? ?? ''),
              maxScore: _num(item['max_score']) ?? 0,
              status: item['status'] as String? ?? 'missing',
              score: _num(item['score']),
            ),
        ],
      );

  final int total;
  final int handedIn;
  final int missing;
  final int upcoming;

  /// `status`: submitted, late, graded, returned, missing or upcoming.
  final List<
    ({String title, DateTime? dueAt, num maxScore, String status, num? score})
  >
  items;
}

class StudentComments {
  const StudentComments({
    required this.termSubjectComment,
    required this.annualSubjectComment,
    required this.termTeacherComment,
  });

  factory StudentComments.fromJson(Map<String, Object?> json) =>
      StudentComments(
        termSubjectComment: json['term_subject_comment'] as String?,
        annualSubjectComment: json['annual_subject_comment'] as String?,
        termTeacherComment: json['term_teacher_comment'] as String?,
      );

  final String? termSubjectComment;
  final String? annualSubjectComment;
  final String? termTeacherComment;

  bool get isEmpty =>
      termSubjectComment == null &&
      annualSubjectComment == null &&
      termTeacherComment == null;
}

class StudentRecordField {
  const StudentRecordField({
    required this.labelEn,
    required this.labelAr,
    required this.valueEn,
    required this.valueAr,
  });

  final String labelEn;
  final String labelAr;
  final String valueEn;
  final String valueAr;

  String label(bool arabic) => arabic && labelAr.isNotEmpty ? labelAr : labelEn;
  String value(bool arabic) => arabic && valueAr.isNotEmpty ? valueAr : valueEn;
}

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const <String, Object?>{};

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    if (item is Map) Map<String, Object?>.from(item),
];

num? _num(Object? value) => value is num ? value : null;

int _int(Object? value) => value is num ? value.toInt() : 0;
