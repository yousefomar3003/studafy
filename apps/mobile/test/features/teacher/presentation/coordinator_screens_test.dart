import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/coordinator_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/mark_sheet_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/coordinator_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/coordinator.dart';
import 'package:studafy_mobile/src/features/teacher/domain/mark_sheet.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/coordinator_mark_sheet_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/coordinator_subjects_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../mark_sheet_fixtures.dart';

Map<String, Object?> _overview({bool empty = false}) => {
  'academic_year_id': 'year-1',
  'subjects': empty
      ? <Object?>[]
      : [
          {
            'coordinator_id': 'coord-1',
            'subject_id': 'sub-math',
            'subject_code': 'MATH',
            'subject_name': 'Mathematics',
            'grade_level_ids': ['grade-7'],
            'sections': [
              {
                'section_id': 'sec-1',
                'section_name': 'A',
                'grade_level_id': 'grade-7',
                'grade_level_name': 'Grade 7',
                'teacher_names': ['Omar Aziz'],
                'student_count': 2,
                'average_percentage': 79,
                'complete_count': 1,
                'sheets': [
                  {
                    'term_id': 't1',
                    'term_name': 'Term 1',
                    'status': 'submitted',
                  },
                  {'term_id': null, 'term_name': null, 'status': 'draft'},
                ],
                'results': [
                  {
                    'term_id': 't1',
                    'term_name': 'Term 1',
                    'average_percentage': 81.25,
                    'student_count': 2,
                    'finalized_at': t0,
                  },
                ],
              },
              {
                'section_id': 'sec-2',
                'section_name': 'B',
                'grade_level_id': 'grade-7',
                'grade_level_name': 'Grade 7',
                'teacher_names': <Object?>[],
                'student_count': 0,
                'average_percentage': null,
                'complete_count': 0,
                'sheets': [
                  {'term_id': 't1', 'term_name': 'Term 1', 'status': 'later'},
                ],
                'results': <Object?>[],
              },
            ],
          },
        ],
};

class _FakeCoordinatorClient implements CoordinatorClient {
  _FakeCoordinatorClient(this.json);

  final Map<String, Object?> json;

  @override
  Future<CoordinatedSubjects> fetchMySubjects({String? academicYearId}) async =>
      CoordinatedSubjects.fromJson(json);
}

Future<void> _pump(
  WidgetTester tester,
  Widget home, {
  Map<String, Object?>? overview,
  FakeMarkSheetClient? marks,
}) async {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          coordinatorClientProvider.overrideWithValue(
            _FakeCoordinatorClient(overview ?? _overview()),
          ),
          markSheetClientProvider.overrideWithValue(
            marks ??
                FakeMarkSheetClient(
                  MarkSheet.fromJson({
                    ...markSheetJson(),
                    'access': 'coordinator',
                    'can_edit_marks': false,
                  }),
                ),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: Scaffold(body: home),
          ),
        ),
      ),
      startLocale: AppLocales.fallback,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('the Coordinator entry shows only to a teacher who coordinates', (
    tester,
  ) async {
    await _pump(
      tester,
      const CoordinatorEntryTile(),
      overview: _overview(empty: true),
    );
    expect(find.text('Coordinator'), findsNothing);

    await _pump(tester, const CoordinatorEntryTile());
    expect(find.text('Coordinator'), findsOneWidget);
    expect(
      find.text(
        'Every section of Mathematics: mark sheets, averages and marks',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Coordinator'));
    await tester.pumpAndSettle();
    expect(find.text('Subjects I coordinate'), findsOneWidget);
  });

  testWidgets('lists each section with its teachers, sheet status and averages', (
    tester,
  ) async {
    await _pump(tester, const CoordinatorSubjectsScreen());

    expect(find.text('Mathematics'), findsOneWidget);
    expect(find.text('Grades: Grade 7'), findsOneWidget);
    expect(find.text('Grade 7 · A'), findsOneWidget);
    expect(find.text('Omar Aziz'), findsOneWidget);
    expect(find.text('2 students · 1 complete'), findsOneWidget);
    expect(find.text('Current average: 79%'), findsOneWidget);
    expect(find.text('Term 1 final average: 81.25%'), findsOneWidget);
    expect(find.text('Awaiting approval'), findsOneWidget);
    // Section B: no teacher, no marks, and a status newer than this build reads as locked.
    expect(find.text('No teacher assigned'), findsOneWidget);
    expect(find.text('No marks yet'), findsOneWidget);
    expect(find.text('Locked'), findsOneWidget);
  });

  testWidgets('a teacher who coordinates nothing is told so', (tester) async {
    await _pump(
      tester,
      const CoordinatorSubjectsScreen(),
      overview: _overview(empty: true),
    );
    expect(
      find.text(
        "You don't coordinate a subject this year. Your school assigns coordinators in Academic setup.",
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'opening a section shows its marks read-only, with no way to write',
    (tester) async {
      await _pump(tester, const CoordinatorSubjectsScreen());
      await tester.tap(find.text('Grade 7 · A'));
      await tester.pumpAndSettle();

      expect(
        find.text('Read only — you coordinate this subject'),
        findsOneWidget,
      );
      expect(find.text('Quiz 1'), findsOneWidget);
      expect(find.text('Midterm'), findsOneWidget);
      expect(find.text('Quiz 1: 18/20\nMidterm: 80/100'), findsOneWidget);
      expect(find.text('Quiz 1: 15/20\nMidterm: —'), findsOneWidget);
      expect(find.text('Exempt'), findsOneWidget);
      // Nothing to submit, add or send.
      expect(find.text('Submit for approval'), findsNothing);
      expect(find.text('Add assessment'), findsNothing);

      // Another period.
      await tester.tap(find.text('Term 2'));
      await tester.pumpAndSettle();
      expect(find.text('Quiz 2'), findsOneWidget);
      expect(find.text('Quiz 1'), findsNothing);
    },
  );

  testWidgets('renders right to left in Arabic', (tester) async {
    tester.view.physicalSize = const Size(1080, 3200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      wrapWithLocalization(
        ProviderScope(
          overrides: [
            coordinatorClientProvider.overrideWithValue(
              _FakeCoordinatorClient(_overview()),
            ),
          ],
          child: Builder(
            builder: (context) => MaterialApp(
              locale: context.locale,
              supportedLocales: context.supportedLocales,
              localizationsDelegates: context.localizationDelegates,
              theme: AppTheme.light,
              home: const CoordinatorSubjectsScreen(),
            ),
          ),
        ),
        startLocale: const Locale('ar'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('المواد التي أنسّقها'), findsOneWidget);
    expect(
      Directionality.of(tester.element(find.text('Mathematics'))),
      TextDirection.rtl,
    );
  });

  test('parsing tolerates missing fields and unknown values', () {
    final overview = CoordinatedSubjects.fromJson({
      'subjects': [
        {
          'subject_id': 'sub-1',
          'sections': [
            {
              'section_id': 'sec-1',
              'sheets': [
                {'status': 'later'},
              ],
            },
          ],
        },
        'not a subject',
      ],
    });
    expect(overview.academicYearId, isNull);
    expect(overview.subjects, hasLength(1));
    final section = overview.subjects.single.sections.single;
    expect(section.averagePercentage, isNull);
    expect(section.teacherNames, isEmpty);
    expect(section.sheets.single.status, MarkSheetPeriodStatus.unknown);
    expect(CoordinatedSubjects.fromJson(const {}).isEmpty, isTrue);
  });

  test('a mark sheet says how it is read; an older server means a teacher', () {
    expect(
      MarkSheet.fromJson({...markSheetJson(), 'access': 'coordinator'}).access,
      MarkSheetAccess.coordinator,
    );
    expect(MarkSheet.fromJson(markSheetJson()).access, MarkSheetAccess.teacher);
    final future = MarkSheet.fromJson({
      ...markSheetJson(),
      'access': 'auditor',
    }).access;
    expect(future, MarkSheetAccess.unknown);
    expect(future.isReadOnly, isTrue);
    expect(MarkSheetAccess.leadership.isReadOnly, isFalse);
  });
}
