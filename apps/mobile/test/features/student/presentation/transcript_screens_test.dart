import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/transcript_providers.dart';
import 'package:studafy_mobile/src/features/student/data/transcript_client.dart';
import 'package:studafy_mobile/src/features/student/domain/transcript.dart';
import 'package:studafy_mobile/src/features/student/presentation/transcript_detail_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/transcripts_section.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _year(
  String id,
  String name,
  String grade, {
  required num average,
}) => {
  'academic_year': {'id': id, 'code': id, 'name': name},
  'grade_level_name': grade,
  'section_name': 'A',
  'finalization': {
    'id': 'fin-$id',
    'version': 1,
    'finalized_at': '2026-06-20T09:00:00.000Z',
  },
  'subjects': [
    {
      'code': 'MAT',
      'name': 'Mathematics',
      'requirement': 'mandatory',
      'marks_obtained': average,
      'max_marks': 100,
      'percentage': average,
      'grade_label': 'A',
      'gpa_points': 4,
      'passed': true,
      'exempt': false,
      'include_in_average': true,
      'average_weight': 3,
    },
  ],
  'overall': {
    'average_percentage': average,
    'total_obtained': average,
    'total_max': 100,
    'grade_label': 'A',
    'subjects_failed': 0,
    'academic_status': 'promoted',
    // The grade shows results out of 20.
    'display': {'format': 'out_of', 'value': average / 5, 'max': 20},
  },
};

Map<String, Object?> _transcript({
  String id = 'tr-1',
  String status = 'issued',
  bool needsReissue = false,
  num? gpa = 3.13,
  String? gpaReason,
  List<String> withoutPoints = const [],
  String? revokeReason,
}) => {
  'id': id,
  'serial_number': 'TR-7K2M9QX4PB',
  'status': status,
  'student_id': 'st-1',
  'issued_at': '2026-07-02T09:00:00.000Z',
  'supersedes_id': null,
  'reissue_reason': null,
  'revoked_at': status == 'revoked' ? '2026-07-05T09:00:00.000Z' : null,
  'revoke_reason': revokeReason,
  'content_sha256': 'abc',
  'needs_reissue': needsReissue,
  'stale_reasons': needsReissue ? ['corrected'] : <String>[],
  'content': {
    'version': 1,
    'kind': 'transcript',
    'serial_number': 'TR-7K2M9QX4PB',
    'issued_at': '2026-07-02T09:00:00.000Z',
    'school': {'id': 'school-1', 'name': 'Al Noor School'},
    'student': {
      'id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'ADM-001',
    },
    'years': [
      _year('y1', '2024–2025', 'Grade 9', average: 90),
      _year('y2', '2025–2026', 'Grade 10', average: 80),
    ],
    'cumulative': {
      'average_percentage': 81.25,
      'gpa': gpa,
      'gpa_unavailable_reason': gpaReason,
      'subjects_without_gpa_points': withoutPoints,
      'years_covered': 2,
      'subjects_counted': 3,
    },
    'issued_by': {'user_id': 'user-1', 'name': 'Principal Rana'},
    'reissue': null,
  },
};

class _FakeTranscriptClient implements TranscriptClient {
  _FakeTranscriptClient(this.rows);

  final List<Map<String, Object?>> rows;
  final List<String> requestedStudents = [];

  @override
  Future<List<AcademicTranscript>> fetchTranscripts(String studentId) async {
    requestedStudents.add(studentId);
    return [for (final row in rows) AcademicTranscript.fromJson(row)];
  }

  @override
  Future<AcademicTranscript> fetchTranscript(String transcriptId) async =>
      AcademicTranscript.fromJson(
        rows.firstWhere((row) => row['id'] == transcriptId),
      );
}

Future<void> _pump(
  WidgetTester tester,
  _FakeTranscriptClient client,
  Widget home, {
  Locale locale = AppLocales.fallback,
}) async {
  tester.view.physicalSize = const Size(1080, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [transcriptClientProvider.overrideWithValue(client)],
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

Widget _section(String studentId) => Scaffold(
  body: ListView(children: [TranscriptsSection(studentId: studentId)]),
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('lists a student\'s transcripts and opens one as issued', (
    tester,
  ) async {
    final client = _FakeTranscriptClient([_transcript()]);
    await _pump(tester, client, _section('st-1'));

    expect(client.requestedStudents, ['st-1']);
    expect(find.text('Transcripts'), findsOneWidget);
    expect(
      find.text('Academic transcript · 2024–2025 – 2025–2026'),
      findsOneWidget,
    );
    expect(find.textContaining('TR-7K2M9QX4PB'), findsOneWidget);

    await tester.tap(find.text('Academic transcript · 2024–2025 – 2025–2026'));
    await tester.pumpAndSettle();

    expect(find.byType(TranscriptDetailScreen), findsOneWidget);
    expect(find.text('Al Noor School'), findsOneWidget);
    expect(find.text('Lina Haddad'), findsOneWidget);
    expect(find.text('2024–2025'), findsOneWidget);
    expect(find.text('Grade 10 · A'), findsOneWidget);
    expect(find.text('81.25%'), findsOneWidget);
    expect(find.text('3.13'), findsOneWidget);
    expect(find.text('Principal Rana'), findsOneWidget);
    expect(find.textContaining('no longer valid'), findsNothing);
  });

  testWidgets('no transcript explains the school issues it', (tester) async {
    await _pump(tester, _FakeTranscriptClient(const []), _section('st-1'));
    expect(find.textContaining('No transcript issued yet'), findsOneWidget);
  });

  testWidgets('a GPA that cannot be worked out names the subjects', (
    tester,
  ) async {
    final client = _FakeTranscriptClient([
      _transcript(
        gpa: null,
        gpaReason: 'missing_gpa_points',
        withoutPoints: ['Art (2025–2026)'],
      ),
    ]);
    await _pump(
      tester,
      client,
      const TranscriptDetailScreen(transcriptId: 'tr-1'),
    );
    expect(
      find.text(
        'No cumulative GPA: these subjects have no GPA points: Art (2025–2026).',
      ),
      findsOneWidget,
    );
  });

  testWidgets('years on different GPA scales explain the missing GPA', (
    tester,
  ) async {
    final row = _transcript(gpa: null, gpaReason: 'mixed_gpa_scales');
    final content = row['content']! as Map<String, Object?>;
    (content['cumulative']! as Map<String, Object?>)['mixed_gpa_scales'] = [
      {'academic_year_name': '2024–2025', 'max': 4},
      {'academic_year_name': '2025–2026', 'max': 5},
    ];
    await _pump(
      tester,
      _FakeTranscriptClient([row]),
      const TranscriptDetailScreen(transcriptId: 'tr-1'),
    );
    expect(
      find.text(
        'No cumulative GPA: the years use different GPA scales '
        '(2024–2025: out of 4, 2025–2026: out of 5), so their points can\'t be averaged.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a descriptive subject shows its descriptor and skills', (
    tester,
  ) async {
    final row = _transcript();
    final content = row['content']! as Map<String, Object?>;
    final year =
        (content['years']! as List<Object?>).first! as Map<String, Object?>;
    year['subjects'] = [
      ...(year['subjects']! as List<Object?>),
      {
        'code': 'RD',
        'name': 'Reading',
        'requirement': 'mandatory',
        'marks_obtained': null,
        'max_marks': 100,
        'percentage': null,
        'grade_label': 'Very good',
        'gpa_points': null,
        'passed': true,
        'exempt': false,
        'include_in_average': false,
        'average_weight': 1,
        'descriptive': true,
        'skills': [
          {
            'name': 'Reads fluently',
            'category_name': 'Reading',
            'descriptor_label': 'Excellent',
          },
        ],
      },
    ];
    await _pump(
      tester,
      _FakeTranscriptClient([row]),
      const TranscriptDetailScreen(transcriptId: 'tr-1'),
    );
    expect(find.text('Reading'), findsOneWidget);
    expect(find.text('Very good'), findsOneWidget);
    expect(find.text('Reads fluently: Excellent'), findsOneWidget);
  });

  testWidgets('a revoked transcript is flagged, an outdated one says so', (
    tester,
  ) async {
    final client = _FakeTranscriptClient([
      _transcript(status: 'revoked', revokeReason: 'Wrong address'),
      _transcript(id: 'tr-2', needsReissue: true),
    ]);
    await _pump(
      tester,
      client,
      const TranscriptDetailScreen(transcriptId: 'tr-1'),
    );
    expect(find.textContaining('no longer valid'), findsOneWidget);
    expect(find.text('Reason: Wrong address'), findsOneWidget);

    await _pump(
      tester,
      client,
      const TranscriptDetailScreen(transcriptId: 'tr-2'),
    );
    expect(
      find.textContaining('The school will issue an updated one'),
      findsOneWidget,
    );
  });

  testWidgets('renders in Arabic', (tester) async {
    final client = _FakeTranscriptClient([_transcript()]);
    await _pump(
      tester,
      client,
      const TranscriptDetailScreen(transcriptId: 'tr-1'),
      locale: const Locale('ar'),
    );
    expect(find.text('المعدل التراكمي'), findsOneWidget);
    expect(find.text('السجل الأكاديمي'), findsWidgets);
    expect(
      Directionality.of(tester.element(find.text('المعدل التراكمي'))).name,
      'rtl',
    );
  });
}
