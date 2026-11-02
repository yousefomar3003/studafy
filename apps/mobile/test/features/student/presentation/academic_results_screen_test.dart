import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/academic_results_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/data/academic_results_client.dart';
import 'package:studafy_mobile/src/features/student/domain/academic_results.dart';
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

Future<void> _pump(
  WidgetTester tester,
  _FakeResultsClient client, {
  Widget home = const AcademicResultsScreen(),
  String? currentStudentId = 'st-1',
  Locale locale = AppLocales.fallback,
}) async {
  tester.view.physicalSize = const Size(1080, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          academicResultsClientProvider.overrideWithValue(client),
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
}
