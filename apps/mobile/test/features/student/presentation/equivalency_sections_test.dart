import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/academic_equivalency_providers.dart';
import 'package:studafy_mobile/src/features/student/data/academic_equivalency_client.dart';
import 'package:studafy_mobile/src/features/student/domain/academic_equivalency.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/equivalency_section.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/multi_year_section.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

class _FakeClient implements AcademicEquivalencyClient {
  _FakeClient({this.equivalency, this.multiYear});

  final Object? equivalency;
  final Object? multiYear;

  @override
  Future<List<EquivalencyEstimate>> fetchEquivalency(String studentId) async =>
      parseStudentEquivalency(equivalency);

  @override
  Future<List<MultiYearResult>> fetchMultiYearResults(String studentId) async =>
      parseStudentMultiYearResults(multiYear);
}

Future<void> _pump(
  WidgetTester tester,
  _FakeClient client, {
  Locale locale = AppLocales.fallback,
}) async {
  tester.view.physicalSize = const Size(1080, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          academicEquivalencyClientProvider.overrideWithValue(client),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const Scaffold(
              body: SingleChildScrollView(
                child: Column(
                  children: [
                    EquivalencySection(studentId: 'st-1'),
                    MultiYearSection(studentId: 'st-1'),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

Map<String, Object?> _subjectStep(
  String subject,
  String grade,
  num? percentage, {
  bool counted = true,
}) => {
  'subject': {'id': subject, 'code': '', 'name': subject},
  'exam': {'id': 'igcse', 'code': 'IGCSE', 'name': 'IGCSE'},
  'grade': grade,
  'percentage': percentage,
  'counted': counted,
  'required_subject': false,
};

final _estimated = {
  'student_id': 'st-1',
  'estimates': [
    {
      'set': {
        'id': 's1',
        'name': 'IGCSE equivalency',
        'source_system': 'igcse_a_level',
      },
      'status': 'estimated',
      'percentage': 92,
      'parts': [
        {
          'index': 0,
          'type': 'exam_subjects',
          'label': 'IGCSE subjects',
          'weight': 100,
          'required': true,
          'status': 'counted',
          'percentage': 92,
          'share': 100,
          'source_value': null,
          'source_max': null,
          'subjects': [
            _subjectStep('Mathematics', 'A*', 98),
            _subjectStep('Arabic', 'A', 93),
            _subjectStep('Art', 'C', 75, counted: false),
          ],
        },
      ],
      'issues': <Object?>[],
    },
  ],
};

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'an estimate shows the notice, the parts and the subjects counted',
    (tester) async {
      await _pump(tester, _FakeClient(equivalency: _estimated));
      expect(find.text('Tawjihi equivalency (estimate)'), findsOneWidget);
      expect(find.textContaining('not an official Ministry'), findsOneWidget);
      expect(find.text('IGCSE equivalency'), findsOneWidget);
      expect(find.text('Estimated'), findsOneWidget);
      expect(find.text('Estimated 92%'), findsOneWidget);
      expect(find.text('92% (100% of the estimate)'), findsOneWidget);
      expect(find.text('Mathematics: A* → 98%'), findsOneWidget);
      expect(find.text('Art: C → 75% · not counted'), findsOneWidget);
    },
  );

  testWidgets(
    'missing data is explained, an unknown status and code degrade neutrally',
    (tester) async {
      await _pump(
        tester,
        _FakeClient(
          equivalency: {
            'estimates': [
              {
                'set': {'name': 'IGCSE equivalency'},
                'status': 'incomplete',
                'percentage': null,
                'parts': [
                  {'index': 0, 'label': 'IGCSE subjects', 'status': 'missing'},
                ],
                'issues': [
                  {
                    'code': 'TOO_FEW_SUBJECTS',
                    'kind': 'missing',
                    'part_index': 0,
                    'required': 8,
                    'actual': 5,
                  },
                ],
              },
              {
                'set': {'name': 'Future set'},
                'status': 'something_new',
                'parts': <Object?>[],
                'issues': [
                  {'code': 'A_NEW_REASON', 'kind': 'a_new_kind'},
                ],
              },
            ],
          },
        ),
      );
      expect(find.text('Missing data'), findsNWidgets(2));
      expect(
        find.text('IGCSE subjects: 5 of 8 subjects needed.'),
        findsOneWidget,
      );
      expect(find.text('Not available'), findsOneWidget);
      expect(find.text('Some information is missing.'), findsOneWidget);
      expect(find.textContaining('Estimated '), findsNothing);
    },
  );

  testWidgets('a multi-year result: complete with subjects, or pending', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeClient(
        multiYear: {
          'results': [
            {
              'config': {'name': 'Tawjihi two years'},
              'status': 'complete',
              'overall_percentage': 83.5,
              'years': [
                {
                  'grade_level': {'name': 'Grade 11'},
                  'weight': 40,
                  'share': 40,
                  'status': 'finalized',
                  'academic_year': {'name': '2025-2026'},
                  'overall_percentage': 85,
                },
                {
                  'grade_level': {'name': 'Grade 12'},
                  'weight': 60,
                  'share': 60,
                  'status': 'finalized',
                  'academic_year': null,
                  'overall_percentage': 82.5,
                },
              ],
              'subjects': [
                {
                  'name': 'Mathematics',
                  'percentage': 78,
                  'years_counted': 2,
                  'by_year': [
                    {'percentage': 90},
                    {'percentage': 70},
                  ],
                },
              ],
            },
            {
              'config': {'name': 'Pending result'},
              'status': 'pending',
              'overall_percentage': null,
              'years': [
                {
                  'grade_level': {'name': 'Grade 12'},
                  'share': 100,
                  'status': 'pending',
                },
              ],
              'subjects': <Object?>[],
            },
          ],
        },
      ),
    );
    expect(find.text('Multi-year result'), findsOneWidget);
    expect(find.text('Complete'), findsOneWidget);
    expect(find.text('Overall 83.5%'), findsOneWidget);
    expect(find.text('Grade 11 (40%)'), findsOneWidget);
    expect(find.text('Final · 2025-2026'), findsOneWidget);
    expect(find.text('Mathematics'), findsOneWidget);
    expect(find.text('90% · 70%'), findsOneWidget);
    expect(find.text('78%'), findsOneWidget);
    expect(find.text('Pending'), findsOneWidget);
    expect(find.text('Not final yet'), findsOneWidget);
  });

  testWidgets('nothing is shown when nothing is shown to the family', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeClient(
        equivalency: const {'estimates': <Object?>[]},
        multiYear: const {'results': <Object?>[]},
      ),
    );
    expect(find.text('Tawjihi equivalency (estimate)'), findsNothing);
    expect(find.text('Multi-year result'), findsNothing);
  });

  testWidgets('renders in Arabic', (tester) async {
    await _pump(
      tester,
      _FakeClient(equivalency: _estimated),
      locale: const Locale('ar'),
    );
    expect(find.text('معادلة التوجيهي (تقديرية)'), findsOneWidget);
    expect(find.text('المعدل التقديري 92%'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
