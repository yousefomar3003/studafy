/// One subject's report card comments for a section and period, from
/// `GET /api/grading/sections/{sectionId}/report-notes` (`SectionReportNotes`), narrowed to the
/// subject the teacher is marking. Hand-written like `mark_sheet.dart`.
library;

class SubjectReportComments {
  const SubjectReportComments({
    required this.subjectId,
    required this.canComment,
    required this.finalized,
    required this.shown,
    required this.students,
  });

  factory SubjectReportComments.fromJson(
    Map<String, Object?> json,
    String subjectId,
  ) {
    final settings = json['settings'] is Map
        ? Map<String, Object?>.from(json['settings']! as Map)
        : const <String, Object?>{};
    final subject = _list(
      json['subjects'],
    ).where((s) => s['subject_id'] == subjectId).firstOrNull;
    return SubjectReportComments(
      subjectId: subjectId,
      canComment: subject?['can_comment'] == true,
      finalized: json['finalized'] == true,
      shown: settings['show_subject_comments'] != false,
      students: [
        for (final student in _list(json['students']))
          (
            studentId: student['student_id']! as String,
            name:
                '${student['first_name'] as String? ?? ''} '
                        '${student['last_name'] as String? ?? ''}'
                    .trim(),
            comment:
                _list(student['subject_comments'])
                        .where((c) => c['subject_id'] == subjectId)
                        .firstOrNull?['body']
                    as String? ??
                '',
          ),
      ],
    );
  }

  final String subjectId;

  /// The signed-in teacher may write them now: they teach the subject here and the period is open.
  final bool canComment;

  /// The period's results are finalized; its comments are frozen.
  final bool finalized;

  /// The school prints subject comments on report cards.
  final bool shown;
  final List<({String studentId, String name, String comment})> students;
}

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    Map<String, Object?>.from(item! as Map),
];
