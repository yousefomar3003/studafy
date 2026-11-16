import 'package:studafy_mobile/src/features/student/data/released_marks_client.dart';
import 'package:studafy_mobile/src/features/student/domain/released_marks.dart';

/// A [ReleasedMarksClient] serving fixed `GET /api/grading/students/{id}/marks` periods (raw
/// JSON, parsed exactly as the real client does), recording which students were asked for.
class FakeReleasedMarksClient implements ReleasedMarksClient {
  FakeReleasedMarksClient({
    this.periods = const [],
    this.periodsByStudent = const {},
    this.fail = false,
  });

  /// Served for any student not in [periodsByStudent].
  final List<Map<String, Object?>> periods;

  /// Per-student responses (a parent's children).
  final Map<String, List<Map<String, Object?>>> periodsByStudent;
  final bool fail;
  final List<String> requestedStudents = [];

  @override
  Future<List<ReleasedMarkPeriod>> fetchMarks(String studentId) async {
    requestedStudents.add(studentId);
    if (fail) throw Exception('offline');
    return [
      for (final row in periodsByStudent[studentId] ?? periods)
        ReleasedMarkPeriod.fromJson(row),
    ];
  }
}

/// The API's response body (`periods`) when leadership approved one assessment of a term on its
/// own — the "First month" exam — and the term's mark sheet was never submitted: one term, one
/// subject not yet period-approved, no `approved_at`, one assessment with its `released_at`.
/// Field for field what `released-marks-single-assessment.integration.test.ts` reads from the
/// real route.
List<Map<String, Object?>> singleReleasedExamPeriods({
  required DateTime releasedAt,
  String subject = 'Mathematics',
  String assessment = 'First month',
  num score = 17.5,
  num maxMarks = 20,
}) => [
  {
    'academic_year_id': 'year-1',
    'academic_year_name': '2026–2027',
    'term_id': 'term-1',
    'term_name': 'First term',
    'subjects': [
      {
        'subject_id': 'sub-$subject',
        'subject_code': subject.substring(0, 2).toUpperCase(),
        'subject_name': subject,
        'approved_at': null,
        'period_approved': false,
        'categories': [
          {
            'category_id': 'cat-exams',
            'name': 'Monthly exams',
            'kind': 'exam',
            'assessments': [
              {
                'assessment_id': 'a-$assessment',
                'name': assessment,
                'max_marks': maxMarks,
                'assessment_date': '2026-11-01',
                'released_at': releasedAt.toUtc().toIso8601String(),
                'attempts': [
                  {
                    'attempt': 1,
                    'status': 'graded',
                    'score': score,
                    'descriptor_label': null,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
