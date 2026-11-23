import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/academic_results_providers.dart';
import 'package:studafy_mobile/src/features/student/application/external_exam_results_providers.dart';
import 'package:studafy_mobile/src/features/student/application/predicted_grades_providers.dart';
import 'package:studafy_mobile/src/features/student/application/graduation_requirements_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/application/transcript_providers.dart';
import 'package:studafy_mobile/src/features/student/data/academic_results_client.dart';
import 'package:studafy_mobile/src/features/student/data/external_exam_results_client.dart';
import 'package:studafy_mobile/src/features/student/data/graduation_requirements_client.dart';
import 'package:studafy_mobile/src/features/student/data/predicted_grades_client.dart';
import 'package:studafy_mobile/src/features/student/data/transcript_client.dart';
import 'package:studafy_mobile/src/features/student/domain/academic_results.dart';
import 'package:studafy_mobile/src/features/student/domain/external_exam_results.dart';
import 'package:studafy_mobile/src/features/student/domain/graduation_requirements.dart';
import 'package:studafy_mobile/src/features/student/domain/predicted_grades.dart';
import 'package:studafy_mobile/src/features/student/domain/transcript.dart';
import 'package:studafy_mobile/src/features/student/presentation/academic_results_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/certificate_detail_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _subject(
  String name, {
  String status = 'complete',
  num? percentage,
  num? obtained,
  num max = 100,
  String? grade,
  bool? passed,
  List<Map<String, Object?>> terms = const [],
}) => {
  'subject_id': 'sub-$name',
  'subject_code': name.substring(0, 3).toUpperCase(),
  'subject_name': name,
  'status': status,
  'percentage': percentage,
  'marks_obtained': obtained,
  'max_marks': max,
  'grade_label': grade,
  'gpa_points': null,
  'passed': passed,
  'include_in_average': true,
  'include_on_certificate': true,
  'requirement': 'mandatory',
  'terms': terms,
  'fail_reasons': <Object?>[],
};

Map<String, Object?> _result({
  required String id,
  String? termId,
  String? termName,
  String academicStatus = 'promoted',
  int version = 1,
  String finalizedAt = '2026-06-20T09:00:00.000Z',
  Map<String, Object?>? display,
}) => {
  'finalization_id': id,
  'academic_year_id': 'year-1',
  'academic_year_name': '2025–2026',
  'section_name': 'A',
  'grade_level_name': 'Grade 7',
  'term_id': termId,
  'term_name': termName,
  'version': version,
  'finalized_at': finalizedAt,
  'result': {
    'student_id': 'st-1',
    'first_name': 'Lina',
    'last_name': 'Haddad',
    'admission_number': 'ADM-001',
    'status': 'complete',
    'average_percentage': 81.25,
    'total_obtained': 162.5,
    'total_max': 200,
    'grade_label': 'B+',
    'result_display': ?display,
    'subjects_failed': 1,
    'academic_status': academicStatus,
    'subjects': [
      _subject(
        'Mathematics',
        percentage: 92.5,
        obtained: 92.5,
        grade: 'A',
        passed: true,
        terms: [
          {'term_id': 't1', 'percentage': 90},
        ],
      ),
      _subject(
        'Physics',
        percentage: 45,
        obtained: 45,
        grade: 'D',
        passed: false,
      ),
      _subject('Music', status: 'exempt'),
    ],
  },
};

Map<String, Object?> _certificate({
  String id = 'cert-1',
  String status = 'issued',
  String? revokedAt,
  String? revokeReason,
  bool needsReissue = false,
  Map<String, Object?>? display,
}) => {
  'id': id,
  'kind': 'annual_certificate',
  'serial_number': 'SCH-2026-0042',
  'status': status,
  'academic_year_id': 'year-1',
  'student_id': 'st-1',
  'finalization_id': 'fin-annual',
  'issued_at': '2026-06-25T09:00:00.000Z',
  'supersedes_id': null,
  'reissue_reason': null,
  'revoked_at': revokedAt,
  'revoke_reason': revokeReason,
  'content_sha256': 'abc',
  'needs_reissue': needsReissue,
  'content': {
    'version': 1,
    'kind': 'annual_certificate',
    'serial_number': 'SCH-2026-0042',
    'issued_at': '2026-06-25T09:00:00.000Z',
    'school': {'id': 'school-1', 'name': 'Al Noor School'},
    'academic_year': {'id': 'year-1', 'code': '2026', 'name': '2025–2026'},
    'term': null,
    'student': {
      'id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'ADM-001',
    },
    'grade_level_name': 'Grade 7',
    'section_name': 'A',
    'subjects': [
      {
        'code': 'MAT',
        'name': 'Mathematics',
        'requirement': 'mandatory',
        'marks_obtained': 92.5,
        'max_marks': 100,
        'percentage': 92.5,
        'grade_label': 'A',
        'passed': true,
        'exempt': false,
        'terms': [
          {'term_id': 't1', 'term_name': 'Term 1', 'percentage': 90},
        ],
      },
    ],
    'overall': {
      'average_percentage': 81.25,
      'total_obtained': 162.5,
      'total_max': 200,
      'grade_label': 'B+',
      'display': ?display,
      'subjects_failed': 1,
      'academic_status': 'supplementary',
    },
    'finalization': {
      'id': 'fin-annual',
      'version': 1,
      'finalized_at': '2026-06-20T09:00:00.000Z',
    },
    'issued_by': {'user_id': 'user-1', 'name': 'Principal Rana'},
    'reissue': null,
  },
};

class _FakeResultsClient implements AcademicResultsClient {
  _FakeResultsClient({this.results = const [], this.certificates = const []});

  final List<Map<String, Object?>> results;
  final List<Map<String, Object?>> certificates;
  final List<String> requestedStudents = [];

  @override
  Future<List<FinalizedResult>> fetchResults(String studentId) async {
    requestedStudents.add(studentId);
    return [for (final row in results) FinalizedResult.fromJson(row)];
  }

  @override
  Future<List<AcademicCertificate>> fetchCertificates(String studentId) async =>
      [for (final row in certificates) AcademicCertificate.fromJson(row)];

  @override
  Future<AcademicCertificate> fetchCertificate(String certificateId) async =>
      AcademicCertificate.fromJson(
        certificates.firstWhere((row) => row['id'] == certificateId),
      );
}

/// No transcripts: this file covers results and certificates (transcripts have their own test).
class _NoTranscriptsClient implements TranscriptClient {
  @override
  Future<List<AcademicTranscript>> fetchTranscripts(String studentId) async =>
      const [];

  @override
  Future<AcademicTranscript> fetchTranscript(String transcriptId) =>
      throw UnimplementedError();
}

/// Test scores as the API sends them (parsed with the app's own parser).
class _FakeTestScoresClient implements ExternalExamResultsClient {
  _FakeTestScoresClient([this.body = const {'results': <Object?>[]}]);

  final Object? body;

  @override
  Future<List<ExternalExamResult>> fetchResults(String studentId) async =>
      parseExternalExamResults(body);
}

/// Predicted grades as the API hands them to a student or parent (no notes).
class _FakePredictedClient implements StudentPredictedGradesClient {
  _FakePredictedClient([this.json]);

  final Map<String, Object?>? json;

  @override
  Future<List<PredictedGradesYear>> fetch(String studentId) async =>
      parsePredictedGradeYears(json);
}

/// A graduation checklist as the API sends it (parsed with the app's own parser).
class _FakeGraduationClient implements GraduationRequirementsClient {
  _FakeGraduationClient([this.body = const {'sets': <Object?>[]}]);

  final Object? body;

  @override
  Future<List<GraduationSetChecklist>> fetchChecklist(String studentId) async =>
      parseGraduationChecklist(body);
}

Future<void> _pump(
  WidgetTester tester,
  _FakeResultsClient client, {
  ExternalExamResultsClient? testScores,
  GraduationRequirementsClient? graduation,
  Widget home = const AcademicResultsScreen(),
  String? currentStudentId = 'st-1',
  Locale locale = AppLocales.fallback,
  _FakePredictedClient? predicted,
}) async {
  tester.view.physicalSize = const Size(1080, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          academicResultsClientProvider.overrideWithValue(client),
          transcriptClientProvider.overrideWithValue(_NoTranscriptsClient()),
          externalExamResultsClientProvider.overrideWithValue(
            testScores ?? _FakeTestScoresClient(),
          ),
          studentPredictedGradesClientProvider.overrideWithValue(
            predicted ?? _FakePredictedClient(),
          ),
          graduationRequirementsClientProvider.overrideWithValue(
            graduation ?? _FakeGraduationClient(),
          ),
          currentStudentIdProvider.overrideWithValue(currentStudentId),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: home,
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('lists test scores read-only, with a total out of its maximum', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(),
      testScores: _FakeTestScoresClient({
        'results': [
          {
            'id': 'r-sat',
            'exam': {'id': 'e-sat', 'name': 'SAT', 'total_max': 1600},
            'subject': null,
            'sat_on': '2026-10-04',
            'total_score': 1480,
            'note': 'First sitting',
            'scores': [
              {
                'component_name': 'Reading and Writing',
                'numeric_score': 720,
                'label_score': null,
              },
              {'component_name': 'Math', 'numeric_score': 760},
            ],
          },
          {
            'id': 'r-igcse',
            'exam': {
              'id': 'e-igcse',
              'name': 'IGCSE (A*-G)',
              'total_max': null,
            },
            'subject': {'id': 's-1', 'code': 'MAT', 'name': 'Mathematics'},
            'sat_on': '2026-06-15',
            'total_score': null,
            'scores': [
              {
                'component_name': 'Grade',
                'numeric_score': null,
                'label_score': 'A*',
              },
            ],
            // A field a newer API might add is ignored.
            'future_field': {'x': 1},
          },
          // Malformed rows are skipped, not fatal.
          {'exam': 'not a map'},
          'not a row',
        ],
      }),
    );

    expect(find.text('Test scores'), findsOneWidget);
    expect(find.text('SAT'), findsOneWidget);
    expect(find.text('1480 / 1600'), findsOneWidget);
    expect(find.text('Reading and Writing: 720'), findsOneWidget);
    expect(find.text('First sitting'), findsOneWidget);
    expect(find.text('IGCSE (A*-G) — Mathematics'), findsOneWidget);
    expect(find.text('Grade: A*'), findsOneWidget);
    // Read-only: nothing to add, edit or delete.
    expect(find.byIcon(Icons.edit_outlined), findsNothing);
    expect(find.byIcon(Icons.delete_outline), findsNothing);
  });

  testWidgets('says so when there are no test scores', (tester) async {
    await _pump(tester, _FakeResultsClient());
    expect(find.text('No external exam results recorded yet.'), findsOneWidget);
  });

  Map<String, Object?> rule(
    String type,
    String status, {
    num? current,
    num? required,
    String? group,
    Map<String, Object?>? exam,
    List<String> missing = const [],
  }) => {
    'id': 'rule-$type',
    'type': type,
    'min_value': required,
    'group_name': group,
    'subjects': <Object?>[],
    'external_exam': exam,
    'status': status,
    'current': current,
    'required': required,
    'missing_subjects': [
      for (final name in missing)
        {'id': 'sub-$name', 'code': 'X', 'name': name},
    ],
  };

  final checklist = {
    'student_id': 'st-1',
    'grade_level': {'id': 'g-12', 'name': 'Grade 12'},
    'current_year_pending': true,
    'years_counted': 3,
    'sets': [
      {
        'set': {
          'id': 'set-1',
          'name': 'High school diploma',
          'visible_to_students_and_parents': true,
        },
        'status': 'not_met',
        'rules_met': 2,
        'rules_total': 6,
        'rules': [
          rule('total_credits', 'met', current: 24.5, required: 24),
          rule(
            'group_credits',
            'pending',
            current: 2,
            required: 4,
            group: 'English',
          ),
          rule(
            'subjects_passed',
            'not_met',
            current: 1,
            required: 2,
            group: 'Core',
            missing: ['Algebra II'],
          ),
          rule('cumulative_gpa', 'pending', current: 3.1, required: 2.5),
          rule(
            'external_exam',
            'met',
            current: 1350,
            exam: {'id': 'e-sat', 'code': 'SAT', 'name': 'SAT'},
          ),
          // A rule type and status a newer API might send.
          rule('community_hours', 'waived'),
        ],
      },
    ],
  };

  testWidgets('shows the graduation checklist: met, not met and in progress', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(),
      graduation: _FakeGraduationClient(checklist),
    );

    expect(find.text('Graduation requirements'), findsOneWidget);
    expect(find.text('High school diploma'), findsOneWidget);
    expect(find.text('2 of 6 requirements met'), findsOneWidget);
    expect(find.text('Total credits'), findsOneWidget);
    expect(find.text('24.5 of 24'), findsOneWidget);
    expect(find.text('Credits in English'), findsOneWidget);
    expect(find.text('2 of 4'), findsOneWidget);
    expect(find.text('Pass Core'), findsOneWidget);
    expect(find.text('Still to pass: Algebra II'), findsOneWidget);
    expect(find.text('Cumulative GPA'), findsOneWidget);
    expect(find.text('3.1 (minimum 2.5)'), findsOneWidget);
    expect(find.text('SAT'), findsOneWidget);
    expect(find.text('Recorded'), findsOneWidget);
    expect(find.text('Requirement'), findsOneWidget);
    // The set and one rule are not met; two rules met; two in progress; one unknown.
    expect(find.text('Not met'), findsNWidgets(2));
    expect(find.text('Met'), findsNWidgets(2));
    expect(find.text('In progress'), findsNWidgets(2));
    expect(find.text('Not available'), findsOneWidget);
  });

  testWidgets('shows nothing when no graduation requirements are shown', (
    tester,
  ) async {
    await _pump(tester, _FakeResultsClient());
    expect(find.text('Graduation requirements'), findsNothing);
  });

  testWidgets('the graduation checklist renders in Arabic', (tester) async {
    await _pump(
      tester,
      _FakeResultsClient(),
      graduation: _FakeGraduationClient(checklist),
      locale: const Locale('ar'),
    );
    expect(find.text('متطلبات التخرج'), findsOneWidget);
    expect(find.text('الساعات المعتمدة في English'), findsOneWidget);
    expect(find.text('قيد الإنجاز'), findsNWidgets(2));
  });

  testWidgets(
    'renders finalized results with overall status and subject table',
    (tester) async {
      final client = _FakeResultsClient(
        results: [
          _result(
            id: 'fin-t1',
            termId: 't1',
            termName: 'Term 1',
            academicStatus: 'incomplete',
            finalizedAt: '2026-01-20T09:00:00.000Z',
          ),
          _result(id: 'fin-annual', academicStatus: 'promoted', version: 2),
        ],
      );
      await _pump(tester, client);

      expect(client.requestedStudents, ['st-1']);
      expect(find.text('2025–2026'), findsOneWidget);
      expect(find.text('Annual result'), findsOneWidget);
      expect(find.text('Term 1'), findsOneWidget);
      expect(find.text('Promoted'), findsOneWidget);
      expect(find.text('Incomplete'), findsOneWidget);
      expect(find.textContaining('Corrected version 2'), findsOneWidget);

      expect(find.text('81.25%'), findsNWidgets(2));
      expect(find.text('162.5 / 200'), findsNWidgets(2));
      expect(find.text('B+'), findsNWidgets(2));
      expect(find.text('Mathematics'), findsNWidgets(2));
      expect(find.text('92.5 / 100'), findsNWidgets(2));
      expect(find.text('Fail'), findsNWidgets(2));
      expect(find.text('Exempt'), findsNWidgets(2));
      // The annual card names its per-term percentages from the term reports.
      expect(find.text('Term 1 90%'), findsOneWidget);
    },
  );

  testWidgets(
    'shows the grade\'s result format with the percentage beside it',
    (tester) async {
      await _pump(
        tester,
        _FakeResultsClient(
          results: [
            _result(
              id: 'fin-annual',
              display: {'format': 'out_of', 'value': 16.25, 'max': 20},
            ),
            _result(
              id: 'fin-t1',
              termId: 't1',
              termName: 'Term 1',
              display: {'format': 'gpa', 'value': null, 'max': 4},
            ),
          ],
        ),
      );

      expect(find.text('16.25 / 20'), findsOneWidget);
      expect(find.text('GPA not available'), findsOneWidget);
      // The percentage stays visible as secondary text under each.
      expect(find.text('81.25%'), findsNWidgets(2));
    },
  );

  testWidgets(
    'shows course levels, credits and the weighted GPA; older results none',
    (tester) async {
      final boosted = _result(
        id: 'fin-annual',
        display: {'format': 'gpa', 'value': 3.25, 'max': 4},
      );
      final result = boosted['result']! as Map<String, Object?>;
      result['weighted_gpa'] = 3.63;
      result['credits_attempted'] = 3;
      result['credits_earned'] = 2;
      final math =
          (result['subjects']! as List<Object?>).first! as Map<String, Object?>;
      math['course_level'] = 'AP';
      math['credits'] = 1;
      math['weighted_gpa_points'] = 5;

      await _pump(
        tester,
        _FakeResultsClient(
          results: [
            boosted,
            // From a server before credits: no such fields at all.
            _result(
              id: 'fin-t1',
              termId: 't1',
              termName: 'Term 1',
              finalizedAt: '2026-01-20T09:00:00.000Z',
            ),
          ],
        ),
      );

      expect(find.text('GPA 3.25 / 4'), findsOneWidget);
      expect(find.text('Weighted GPA'), findsOneWidget);
      expect(find.text('3.63'), findsOneWidget);
      expect(find.text('Credits earned'), findsOneWidget);
      expect(find.text('2 / 3'), findsOneWidget);
      expect(find.text('AP'), findsOneWidget);
      expect(find.text('Credits: 1'), findsOneWidget);
      expect(find.text('Weighted 5'), findsOneWidget);
    },
  );

  testWidgets('predicted grades show by year when the school shares them', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(),
      predicted: _FakePredictedClient({
        'student_id': 'st-1',
        'years': [
          {
            'academic_year_id': 'year-2',
            'academic_year_name': '2026–2027',
            'section_name': 'A',
            'grade_level_name': 'Year 13',
            'grades': [
              {
                'term_id': null,
                'term_name': null,
                'subject_name': 'Physics',
                'grade_label': 'A*',
                'note': null,
              },
              {
                'term_id': 't1',
                'term_name': 'Term 1',
                'subject_name': 'Physics',
                'grade_label': 'A',
              },
              // Unknown shapes are skipped, not fatal.
              {'subject_name': 'Broken'},
            ],
          },
          // A year with nothing visible takes no space.
          {'academic_year_name': '2025–2026', 'grades': <Object?>[]},
        ],
      }),
    );

    expect(find.text('Predicted grades'), findsOneWidget);
    expect(find.text('2026–2027 · Year 13 A'), findsOneWidget);
    expect(find.text('Physics · Whole year'), findsOneWidget);
    expect(find.text('Physics · Term 1'), findsOneWidget);
    expect(find.text('A*'), findsOneWidget);
    expect(find.text('2025–2026'), findsNothing);
    expect(find.textContaining('Broken'), findsNothing);
  });

  testWidgets('no predicted grades section when none are shared', (
    tester,
  ) async {
    await _pump(tester, _FakeResultsClient());

    expect(find.text('Predicted grades'), findsNothing);
  });

  testWidgets(
    'shows the class rank and percentile; a pending rank says so; older results none',
    (tester) async {
      final ranked = _result(id: 'fin-annual');
      (ranked['result']! as Map<String, Object?>)['class_rank'] = {
        'status': 'ranked',
        'basis': 'average',
        'scope': 'grade_level',
        'rank': 3,
        'cohort_size': 120,
        'percentile': 97,
      };
      final pending = _result(
        id: 'fin-t1',
        termId: 't1',
        termName: 'Term 1',
        finalizedAt: '2026-01-20T09:00:00.000Z',
      );
      (pending['result']! as Map<String, Object?>)['class_rank'] = {
        'status': 'pending',
        'basis': 'average',
        'scope': 'grade_level',
        'rank': null,
        'cohort_size': null,
        'percentile': null,
      };
      // From a server before class ranks: no such field at all.
      final older = _result(
        id: 'fin-t2',
        termId: 't2',
        termName: 'Term 2',
        finalizedAt: '2026-03-20T09:00:00.000Z',
      );

      await _pump(
        tester,
        _FakeResultsClient(results: [ranked, pending, older]),
      );

      expect(find.text('3rd of 120'), findsOneWidget);
      expect(find.text('97th percentile'), findsOneWidget);
      expect(find.text('Rank pending'), findsOneWidget);
      expect(find.text('Class rank'), findsNWidgets(2));
    },
  );

  test('a class rank parses defensively', () {
    ClassRank? parse(Object? json) => ClassRank.fromJson(json);
    expect(parse(null), isNull);
    expect(parse('3rd'), isNull);
    // A status this build doesn't know, or a "ranked" without its numbers: nothing shown.
    expect(
      parse({'status': 'provisional', 'rank': 2, 'cohort_size': 9}),
      isNull,
    );
    expect(parse({'status': 'ranked', 'rank': null, 'cohort_size': 9}), isNull);
    expect(
      parse({'status': 'not_ranked', 'cohort_size': 9})?.status,
      ClassRankStatus.notRanked,
    );
    // A document's rank has no status: it was ranked when issued.
    final kept = parse({'rank': 1, 'cohort_size': 30, 'percentile': 96});
    expect(kept?.status, ClassRankStatus.ranked);
    expect([kept?.rank, kept?.cohortSize, kept?.percentile], [1, 30, 96]);
  });

  testWidgets(
    'a certificate shows the rank it was issued with, in Arabic too',
    (tester) async {
      final certificate = _certificate();
      final content = certificate['content']! as Map<String, Object?>;
      (content['overall']! as Map<String, Object?>)['class_rank'] = {
        'rank': 2,
        'cohort_size': 31,
        'percentile': 93,
        'basis': 'average',
        'scope': 'section',
      };
      await _pump(
        tester,
        _FakeResultsClient(
          results: [_result(id: 'fin-annual')],
          certificates: [certificate],
        ),
        locale: const Locale('ar'),
      );
      await tester.tap(find.textContaining('2025–2026').last);
      await tester.pumpAndSettle();

      expect(find.text('المرتبة 2 من 31'), findsOneWidget);
      expect(find.text('المئين 93'), findsOneWidget);
    },
  );

  testWidgets('a certificate shows its GPA; an older one its percentage', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(
        results: [_result(id: 'fin-annual')],
        certificates: [
          _certificate(display: {'format': 'gpa', 'value': 3.4, 'max': 4}),
        ],
      ),
    );
    await tester.tap(find.text('Certificate · 2025–2026'));
    await tester.pumpAndSettle();

    expect(find.text('GPA 3.4 / 4'), findsOneWidget);
    expect(find.text('81.25%'), findsOneWidget);
  });

  testWidgets('a parent sees the selected child\'s results', (tester) async {
    final client = _FakeResultsClient(results: [_result(id: 'fin-annual')]);
    await _pump(
      tester,
      client,
      currentStudentId: null,
      home: const AcademicResultsScreen(
        studentId: 'child-7',
        studentName: 'Yousef',
      ),
    );

    expect(client.requestedStudents, ['child-7']);
    expect(find.text('Yousef'), findsOneWidget);
    expect(find.text('Promoted'), findsOneWidget);
  });

  testWidgets('no finalized results shows the empty state', (tester) async {
    await _pump(tester, _FakeResultsClient());

    expect(
      find.text(
        'No finalized results yet. They appear here once the school finalizes them.',
      ),
      findsOneWidget,
    );
    expect(
      find.text('No certificates or report cards issued yet.'),
      findsOneWidget,
    );
  });

  testWidgets('lists certificates and opens one rendered from its content', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(
        results: [_result(id: 'fin-annual')],
        certificates: [_certificate()],
      ),
    );

    expect(
      find.text('Serial no. SCH-2026-0042\nIssued Jun 25, 2026'),
      findsOneWidget,
    );
    expect(find.text('Issued'), findsOneWidget);

    await tester.tap(find.text('Certificate · 2025–2026'));
    await tester.pumpAndSettle();

    expect(find.byType(CertificateDetailScreen), findsOneWidget);
    expect(find.text('Al Noor School'), findsOneWidget);
    expect(find.text('Lina Haddad'), findsOneWidget);
    expect(find.text('SCH-2026-0042'), findsOneWidget);
    expect(find.text('Principal Rana'), findsOneWidget);
    // The overall standing comes from the stored content, not the live result.
    expect(find.text('Supplementary exams'), findsOneWidget);
    expect(find.text('Term 1 90%'), findsOneWidget);
    expect(find.textContaining('no longer valid'), findsNothing);
  });

  testWidgets('a revoked certificate is flagged with its date and reason', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(
        certificates: [
          _certificate(
            status: 'revoked',
            revokedAt: '2026-07-01T09:00:00.000Z',
            revokeReason: 'Issued in error',
          ),
        ],
      ),
      home: const CertificateDetailScreen(certificateId: 'cert-1'),
    );

    expect(
      find.text('This document was revoked and is no longer valid.'),
      findsOneWidget,
    );
    expect(find.text('Revoked Jul 1, 2026'), findsOneWidget);
    expect(find.text('Reason: Issued in error'), findsOneWidget);
    expect(find.text('Revoked'), findsOneWidget);
  });

  testWidgets('a descriptive subject shows its descriptor and skills', (
    tester,
  ) async {
    final certificate = _certificate();
    final content = certificate['content']! as Map<String, Object?>;
    content['subjects'] = [
      ...(content['subjects']! as List<Object?>),
      {
        'code': 'RD',
        'name': 'Reading',
        'requirement': 'mandatory',
        'marks_obtained': null,
        'max_marks': 100,
        'percentage': null,
        'grade_label': 'Very good',
        'passed': true,
        'exempt': false,
        'terms': <Object?>[],
        'descriptive': true,
        'skills': [
          {
            'name': 'Reads fluently',
            'category_name': 'Reading',
            'term_name': 'Term 1',
            'descriptor_label': 'Excellent',
          },
          {
            'name': 'Knows letters',
            'category_name': 'Reading',
            'term_name': 'Term 1',
            'descriptor_label': 'Good',
          },
        ],
      },
    ];
    await _pump(
      tester,
      _FakeResultsClient(certificates: [certificate]),
      home: const CertificateDetailScreen(certificateId: 'cert-1'),
    );

    expect(find.text('Reading'), findsOneWidget);
    expect(find.text('Very good'), findsOneWidget);
    expect(find.text('Reads fluently: Excellent'), findsOneWidget);
    expect(find.text('Knows letters: Good'), findsOneWidget);
  });

  testWidgets('a superseded certificate is flagged as replaced', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(certificates: [_certificate(status: 'superseded')]),
      home: const CertificateDetailScreen(certificateId: 'cert-1'),
    );

    expect(
      find.text(
        'This document was replaced by a newer version and is no longer valid.',
      ),
      findsOneWidget,
    );
    expect(find.text('Superseded'), findsOneWidget);
  });

  testWidgets('renders in Arabic', (tester) async {
    await _pump(
      tester,
      _FakeResultsClient(results: [_result(id: 'fin-annual')]),
      locale: const Locale('ar'),
    );

    expect(find.text('النتيجة السنوية'), findsOneWidget);
    expect(find.text('ناجح ومنقول'), findsOneWidget);
  });

  const report = {
    'teacher_comment': 'A kind and focused classmate.',
    'principal_comment': 'Well done this year.',
    'conduct': {'code': 'excellent', 'label': 'Excellent', 'label_ar': 'ممتاز'},
    'attendance': {
      'from': '2025-09-01',
      'to': '2026-06-30',
      'days_recorded': 170,
      'days_present': 164,
      'days_absent': 4,
      'days_late': 3,
      'days_excused': 2,
    },
  };

  testWidgets('shows the frozen comments, conduct and attendance on a result', (
    tester,
  ) async {
    final row = _result(id: 'fin-annual');
    final result = row['result']! as Map<String, Object?>;
    result['report'] = report;
    final subjects = result['subjects']! as List<Map<String, Object?>>;
    subjects[0] = {...subjects[0], 'comment': 'Strong problem solver.'};
    await _pump(tester, _FakeResultsClient(results: [row]));

    expect(find.text("Teachers' comments"), findsOneWidget);
    expect(find.text('Strong problem solver.'), findsOneWidget);
    expect(find.text('Excellent'), findsOneWidget);
    expect(find.text('Days absent'), findsOneWidget);
    expect(find.text('4'), findsOneWidget);
    expect(find.text('A kind and focused classmate.'), findsOneWidget);
    expect(find.text('Well done this year.'), findsOneWidget);
  });

  testWidgets('a result from before report card notes shows none of them', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeResultsClient(results: [_result(id: 'fin-annual')]),
    );

    expect(find.text("Teachers' comments"), findsNothing);
    expect(find.text('Conduct'), findsNothing);
    expect(find.text("Class teacher's comment"), findsNothing);
  });

  testWidgets('the certificate prints the conduct rating in Arabic', (
    tester,
  ) async {
    final cert = _certificate();
    final content = cert['content']! as Map<String, Object?>;
    content['report'] = report;
    await _pump(
      tester,
      _FakeResultsClient(certificates: [cert]),
      home: const CertificateDetailScreen(certificateId: 'cert-1'),
      locale: const Locale('ar'),
    );

    expect(find.text('ممتاز'), findsOneWidget);
    expect(find.text('ملاحظة المدير'), findsOneWidget);
    expect(find.text('Well done this year.'), findsOneWidget);
  });
}
