import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/predicted_grades_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/predicted_grades_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/predicted_grades.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/predicted_grades_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _view({
  bool enabled = true,
  bool editable = true,
  List<String> labels = const ['A*', 'A', 'B', 'C'],
}) => {
  'section_id': 'sec-1',
  'section_name': 'A',
  'grade_level_name': 'Year 13',
  'academic_year_id': 'year-1',
  'subject_id': 'sub-math',
  'subject_name': 'Mathematics',
  'term_id': null,
  'enabled': enabled,
  'visibility': 'staff',
  'editable': editable,
  'labels': labels,
  'terms': [
    {'term_id': 'term-1', 'term_name': 'Term 1'},
  ],
  'students': [
    {
      'student_id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'A-1',
      'grade_label': 'A',
      'note': null,
      'updated_at': '2026-11-01T10:00:00.000Z',
    },
    {
      'student_id': 'st-2',
      'first_name': 'Omar',
      'last_name': 'Saleh',
      'admission_number': 'A-2',
      'grade_label': null,
      'note': null,
      'updated_at': null,
    },
  ],
};

class _FakeClient implements PredictedGradesClient {
  _FakeClient(
    this.json, {
    this.target = (sectionId: 'sec-1', subjectId: 'sub-math'),
  });

  Map<String, Object?> json;
  final ({String sectionId, String subjectId})? target;
  final List<(String?, Map<String, String?>)> saves = [];
  final List<String?> fetchedTerms = [];

  @override
  Future<({String sectionId, String subjectId})?> classTarget(
    String classId,
  ) async => target;

  @override
  Future<SectionPredictedGrades> fetch(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    fetchedTerms.add(termId);
    return SectionPredictedGrades.fromJson(json);
  }

  @override
  Future<SectionPredictedGrades> save(
    String sectionId,
    String subjectId, {
    required String? termId,
    required Map<String, String?> grades,
  }) async {
    saves.add((termId, grades));
    return SectionPredictedGrades.fromJson(json);
  }
}

Future<void> _pump(WidgetTester tester, _FakeClient client) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [predictedGradesClientProvider.overrideWithValue(client)],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const PredictedGradesScreen(
              classId: 'class-1',
              classCode: 'MATH-13A',
            ),
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

  testWidgets(
    'a teacher picks a grade from the scale and saves only what changed',
    (tester) async {
      final client = _FakeClient(_view());
      await _pump(tester, client);

      expect(find.text('Mathematics · Year 13 A'), findsOneWidget);
      expect(find.text('A'), findsOneWidget); // Lina's saved prediction

      await tester.tap(find.text('No prediction').last); // Omar has none yet
      await tester.pumpAndSettle();
      await tester.tap(find.text('A*').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(client.saves.single.$1, isNull);
      expect(client.saves.single.$2, {'st-2': 'A*'});
      expect(find.text('Predicted grades saved'), findsOneWidget);
    },
  );

  testWidgets('choosing a term loads that term\'s predictions', (tester) async {
    final client = _FakeClient(_view());
    await _pump(tester, client);

    await tester.tap(find.text('Whole year'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Term 1').last);
    await tester.pumpAndSettle();

    expect(client.fetchedTerms, [null, 'term-1']);
  });

  testWidgets('a subject without a scale takes a typed grade', (tester) async {
    final client = _FakeClient(_view(labels: const []));
    await _pump(tester, client);

    await tester.enterText(find.widgetWithText(TextField, 'Omar Saleh'), '7');
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(client.saves.single.$1, isNull);
    expect(client.saves.single.$2, {'st-2': '7'});
  });

  testWidgets('switched off for the grade: read-only with an explanation', (
    tester,
  ) async {
    await _pump(tester, _FakeClient(_view(enabled: false, editable: false)));

    expect(
      find.text(
        "Your school hasn't switched predicted grades on for this grade.",
      ),
      findsOneWidget,
    );
    expect(find.text('Save'), findsNothing);
  });

  testWidgets('a class without a section explains there is nothing to predict', (
    tester,
  ) async {
    await _pump(tester, _FakeClient(_view(), target: null));

    expect(
      find.text(
        "This class isn't linked to a grade section, so it has no predicted grades.",
      ),
      findsOneWidget,
    );
  });

  test('parsing tolerates missing and unexpected fields', () {
    final view = SectionPredictedGrades.fromJson({
      'labels': ['A', 3, null],
      'terms': [
        {'term_name': 'No id'},
      ],
      'students': [
        {'student_id': 'st-1'},
        'garbage',
      ],
    });
    expect(view.enabled, isFalse);
    expect(view.editable, isFalse);
    expect(view.labels, ['A']);
    expect(view.terms, isEmpty);
    expect(view.students.single.studentId, 'st-1');
    expect(view.students.single.gradeLabel, isNull);
  });
}
