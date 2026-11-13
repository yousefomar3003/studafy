import 'package:dio/dio.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/teacher/data/mark_sheet_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/mark_sheet.dart';

// ---------------------------------------------------------------------------
// MarkSheet JSON fixture — shaped exactly like `GET .../marks` (`markSheetSchema`)
// ---------------------------------------------------------------------------

const t0 = '2026-09-01T08:00:00.000Z';

/// Two terms; Term 1 has "Quiz 1" (max 20, quizzes) and "Midterm" (max 100, exams); Term 2 has
/// "Quiz 2" (max 20). Three students:
///
/// * `st-lina` — every mark recorded; preview complete (85.5%, A, passed).
/// * `st-omar` — only Quiz 1 recorded; preview incomplete (provisional 72.5%), missing Midterm
///   and Quiz 2.
/// * `st-sara` — exempt; `preview: null`, as the API sends it.
Map<String, Object?> markSheetJson({
  String term1Status = 'draft',
  String? term1ReturnReason,
  String term2Status = 'draft',
  bool canEditMarks = true,
  bool canAddAssessments = false,
  String retakePolicy = 'none',
}) => {
  'section': {
    'id': 'sec-1',
    'name': 'A',
    'grade_level_name': 'Grade 7',
    'academic_year_id': 'year-1',
  },
  'subject': {'id': 'sub-math', 'code': 'MATH', 'name': 'Mathematics'},
  'config_id': 'cfg-1',
  'source': 'inherited',
  'year_status': canEditMarks ? 'active' : 'finalized',
  'can_edit_marks': canEditMarks,
  'can_add_assessments': canAddAssessments,
  'config': {
    'grading_method': 'weighted',
    'max_marks': 100,
    'pass_percentage': 50,
    'final_exam_pass_percentage': null,
    'rounding_decimals': 1,
    'missing_mark_policy': 'incomplete',
    'absent_policy': 'zero',
    'retake_policy': retakePolicy,
    'instructions': 'Enter marks within a week of the assessment.',
    'weight_summary': {
      'termCategoryTotal': 100,
      'annualTotal': 100,
      'valid': true,
    },
  },
  'terms': [
    {'id': 't2', 'name': 'Term 2', 'sequence_number': 2, 'weight': 50},
    {'id': 't1', 'name': 'Term 1', 'sequence_number': 1, 'weight': 50},
  ],
  'categories': [
    {
      'id': 'c-quiz',
      'name': 'Quizzes',
      'kind': 'quiz',
      'scope': 'term',
      'weight': 40,
      'aggregation': 'weighted_average',
      'drop_lowest': 0,
    },
    {
      'id': 'c-exam',
      'name': 'Exams',
      'kind': 'exam',
      'scope': 'term',
      'weight': 60,
      'aggregation': 'weighted_average',
      'drop_lowest': 0,
    },
  ],
  'assessments': [
    _assessment('a-quiz1', 'c-quiz', 't1', 'Quiz 1', 20),
    _assessment('a-mid', 'c-exam', 't1', 'Midterm', 100),
    _assessment('a-quiz2', 'c-quiz', 't2', 'Quiz 2', 20),
  ],
  'mark_sheets': [
    {
      'id': term1Status == 'draft' ? null : 'ms-1',
      'term_id': 't1',
      'status': term1Status,
      'submitted_at': term1Status == 'draft' ? null : t0,
      'decided_at': null,
      'return_reason': term1ReturnReason,
    },
    {
      'id': null,
      'term_id': 't2',
      'status': term2Status,
      'submitted_at': null,
      'decided_at': null,
      'return_reason': null,
    },
  ],
  'students': [
    {
      'student_id': 'st-lina',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'ADM-001',
      'status': 'enrolled',
      'marks': [
        _mark('m-1', 'a-quiz1', 18),
        _mark('m-2', 'a-mid', 80),
        _mark('m-3', 'a-quiz2', 19),
      ],
      'preview': {
        'status': 'complete',
        'percentage': 85.5,
        'provisional_percentage': 85.5,
        'grade_label': 'A',
        'passed': true,
        'missing_assessment_ids': <String>[],
        'terms': [
          {'term_id': 't1', 'percentage': 84, 'incomplete': false},
          {'term_id': 't2', 'percentage': 87, 'incomplete': false},
        ],
      },
    },
    {
      'student_id': 'st-omar',
      'first_name': 'Omar',
      'last_name': 'Saleh',
      'admission_number': 'ADM-002',
      'status': 'enrolled',
      'marks': [_mark('m-4', 'a-quiz1', 15)],
      'preview': {
        'status': 'incomplete',
        'percentage': null,
        'provisional_percentage': 72.5,
        'grade_label': null,
        'passed': null,
        'missing_assessment_ids': ['a-mid', 'a-quiz2'],
        'terms': [
          {'term_id': 't1', 'percentage': 75, 'incomplete': true},
          {'term_id': 't2', 'percentage': null, 'incomplete': true},
        ],
      },
    },
    {
      'student_id': 'st-sara',
      'first_name': 'Sara',
      'last_name': 'Nasser',
      'admission_number': 'ADM-003',
      'status': 'exempt',
      'marks': <Object?>[],
      'preview': null,
    },
  ],
};

Map<String, Object?> _assessment(
  String id,
  String categoryId,
  String? termId,
  String name,
  num max,
) => {
  'id': id,
  'category_id': categoryId,
  'term_id': termId,
  'name': name,
  'max_marks': max,
  'weight': 1,
  'is_mandatory': true,
  'assessment_date': null,
  'due_date': null,
  'status': 'active',
  'section_specific': false,
};

Map<String, Object?> _mark(String id, String assessmentId, num score) => {
  'id': id,
  'assessment_id': assessmentId,
  'attempt': 1,
  'status': 'graded',
  'score': score,
  'remarks': null,
  'updated_at': '2026-09-10T10:00:00.000Z',
};

MarkSheet markSheetFixture({
  String term1Status = 'draft',
  String? term1ReturnReason,
  bool canEditMarks = true,
  bool canAddAssessments = false,
  String retakePolicy = 'none',
}) => MarkSheet.fromJson(
  markSheetJson(
    term1Status: term1Status,
    term1ReturnReason: term1ReturnReason,
    canEditMarks: canEditMarks,
    canAddAssessments: canAddAssessments,
    retakePolicy: retakePolicy,
  ),
);

/// A `DioException` carrying a problem+json [ApiException], as `ErrorMappingInterceptor` builds.
DioException problem(int status, String code, {String? detail}) {
  final options = RequestOptions(path: '/api/grading');
  return DioException(
    requestOptions: options,
    response: Response(requestOptions: options, statusCode: status),
    type: DioExceptionType.badResponse,
    error: ApiException(
      status: status,
      title: code,
      code: code,
      detail: detail,
    ),
  );
}

/// In-memory [MarkSheetClient]: serves [sheet], records every write.
class FakeMarkSheetClient implements MarkSheetClient {
  FakeMarkSheetClient(this.sheet, {this.assignments = const []});

  MarkSheet sheet;
  List<GradingAssignment> assignments;

  final List<List<MarkEntryInput>> saveCalls = [];
  final List<String?> submitCalls = [];

  /// When set, the next `saveMarks` / `submitPeriod` throws it instead.
  DioException? saveError;
  DioException? submitError;

  /// What `saveMarks` returns; defaults to [sheet] unchanged.
  MarkSheet? sheetAfterSave;

  @override
  Future<List<GradingAssignment>> listMyAssignments({
    String? academicYearId,
  }) async => assignments;

  @override
  Future<MarkSheet> fetchMarkSheet(String sectionId, String subjectId) async =>
      sheet;

  @override
  Future<MarkSheet> saveMarks(
    String sectionId,
    String subjectId,
    List<MarkEntryInput> entries,
  ) async {
    saveCalls.add(entries);
    if (saveError != null) throw saveError!;
    return sheet = sheetAfterSave ?? sheet;
  }

  @override
  Future<MarkSheetPeriodStatus> submitPeriod(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    submitCalls.add(termId);
    if (submitError != null) throw submitError!;
    return MarkSheetPeriodStatus.submitted;
  }

  @override
  Future<String> addAssessment(
    String sectionId,
    String subjectId, {
    required String categoryId,
    required String? termId,
    required String name,
    required double maxMarks,
    double weight = 1,
    bool isMandatory = true,
  }) async => 'proposed';
}
