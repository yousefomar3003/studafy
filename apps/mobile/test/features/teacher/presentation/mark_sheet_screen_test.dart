import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/mark_sheet_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/mark_sheet.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/assessment_marks_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/grading_assignments_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/mark_sheet_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../mark_sheet_fixtures.dart';

const _key = (sectionId: 'sec-1', subjectId: 'sub-math');

Widget _app(Widget home) => Builder(
  builder: (context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    locale: context.locale,
    supportedLocales: context.supportedLocales,
    localizationsDelegates: context.localizationDelegates,
    theme: AppTheme.light,
    home: home,
  ),
);

Future<void> _pump(
  WidgetTester tester,
  FakeMarkSheetClient client, {
  Widget? home,
  Locale locale = AppLocales.fallback,
}) async {
  // Tall enough that the whole sheet (rules, assessments and roster) is built at once.
  tester.view.physicalSize = const Size(1080, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [markSheetClientProvider.overrideWithValue(client)],
        child: _app(
          home ??
              const MarkSheetScreen(
                sectionId: 'sec-1',
                subjectId: 'sub-math',
                title: 'Mathematics',
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

  group('MarkSheetScreen', () {
    testWidgets(
      'an incomplete student shows a provisional percentage, never a final grade',
      (tester) async {
        await _pump(tester, FakeMarkSheetClient(markSheetFixture()));

        // Omar: incomplete — labelled provisional, flagged incomplete, missing a Term 1 mark.
        expect(find.text('Provisional: 72.5%'), findsOneWidget);
        expect(find.text('72.5%'), findsNothing);
        expect(find.text('Incomplete'), findsOneWidget);
        expect(find.text('Missing marks: 1'), findsOneWidget);

        // Lina: complete — final percentage with grade label and pass.
        expect(find.text('85.5% · A'), findsOneWidget);
        expect(find.text('Pass'), findsOneWidget);

        // Sara: exempt, no preview.
        expect(find.text('Exempt'), findsOneWidget);

        // Period summary and per-assessment missing count.
        expect(find.text('Students with missing marks: 1'), findsOneWidget);
        expect(find.text('Missing: 1'), findsOneWidget);
      },
    );

    testWidgets('shows the grading rules summary', (tester) async {
      await _pump(tester, FakeMarkSheetClient(markSheetFixture()));

      await tester.tap(find.text('Grading rules'));
      await tester.pumpAndSettle();

      expect(find.text('Weighted categories'), findsOneWidget);
      expect(find.text('Counts as zero'), findsOneWidget); // absent policy
      expect(find.text('Result stays incomplete'), findsOneWidget);
      expect(find.text('Quizzes'), findsWidgets);
      expect(find.text('40%'), findsOneWidget);
      expect(
        find.text('Enter marks within a week of the assessment.'),
        findsOneWidget,
      );
    });

    testWidgets('a returned period shows the reviewer\'s reason', (
      tester,
    ) async {
      await _pump(
        tester,
        FakeMarkSheetClient(
          markSheetFixture(
            term1Status: 'returned',
            term1ReturnReason: 'Recheck the midterm marks',
          ),
        ),
      );

      expect(
        find.text('Returned by the reviewer: Recheck the midterm marks'),
        findsOneWidget,
      );
      expect(find.text('Submit for approval'), findsOneWidget);
    });

    testWidgets(
      'a locked (submitted) period is read-only with no submit action',
      (tester) async {
        await _pump(
          tester,
          FakeMarkSheetClient(markSheetFixture(term1Status: 'submitted')),
        );

        // Term 1 is no longer open, so the screen lands on Term 2 — switch back to Term 1.
        await tester.tap(find.widgetWithText(ChoiceChip, 'Term 1'));
        await tester.pumpAndSettle();

        expect(find.textContaining('Submitted for approval.'), findsOneWidget);
        expect(find.text('Submit for approval'), findsNothing);

        // Opening an assessment: every field disabled, no status menu, no Save.
        await tester.tap(find.text('Quiz 1'));
        await tester.pumpAndSettle();

        expect(find.byType(AssessmentMarksScreen), findsOneWidget);
        final fields = tester.widgetList<TextField>(find.byType(TextField));
        expect(fields, isNotEmpty);
        expect(fields.every((field) => field.enabled == false), isTrue);
        expect(find.byType(PopupMenuButton<Object?>), findsNothing);
        expect(find.byKey(const ValueKey('mark-save')), findsNothing);
      },
    );

    testWidgets('submit is blocked locally while marks are missing', (
      tester,
    ) async {
      final client = FakeMarkSheetClient(markSheetFixture());
      await _pump(tester, client);

      await tester.tap(find.text('Submit for approval'));
      await tester.pumpAndSettle();

      expect(find.text('Marks are missing'), findsOneWidget);
      expect(find.text('Omar Saleh'), findsWidgets);
      expect(client.submitCalls, isEmpty);
    });

    testWidgets('a complete period is submitted after confirmation', (
      tester,
    ) async {
      final json = markSheetJson();
      // Give Omar his Term 1 midterm so Term 1 is complete.
      final omar =
          (json['students']! as List<Object?>)[1]! as Map<String, Object?>;
      omar['preview'] = {
        ...(omar['preview']! as Map<String, Object?>),
        'missing_assessment_ids': ['a-quiz2'],
      };
      final client = FakeMarkSheetClient(MarkSheet.fromJson(json));
      await _pump(tester, client);

      await tester.tap(find.text('Submit for approval'));
      await tester.pumpAndSettle();
      expect(find.text('Submit Term 1 for approval?'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Submit'));
      await tester.pumpAndSettle();

      expect(client.submitCalls, ['t1']);
      expect(find.text('Submitted for approval.'), findsOneWidget);
    });

    testWidgets('renders right-to-left in Arabic', (tester) async {
      await _pump(
        tester,
        FakeMarkSheetClient(markSheetFixture()),
        locale: const Locale('ar'),
      );

      expect(find.text('مؤقتة: 72.5%'), findsOneWidget);
      final direction = Directionality.of(
        tester.element(find.byType(MarkSheetScreen)),
      );
      expect(direction, TextDirection.rtl);
    });
  });

  group('AssessmentMarksScreen', () {
    testWidgets('an out-of-range score is flagged and never saved', (
      tester,
    ) async {
      final client = FakeMarkSheetClient(markSheetFixture());
      await _pump(
        tester,
        client,
        home: const AssessmentMarksScreen(
          sheetKey: _key,
          assessmentId: 'a-quiz1',
        ),
      );

      final omarField = find.byKey(const ValueKey('mark-field-st-omar-1'));
      await tester.enterText(omarField, '25');
      await tester.pumpAndSettle();

      expect(find.text('Enter 0–20'), findsOneWidget);
      expect(
        find.text('Fix the highlighted marks before saving.'),
        findsOneWidget,
      );
      final save = tester.widget<FilledButton>(
        find.byKey(const ValueKey('mark-save')),
      );
      expect(save.onPressed, isNull);
      await tester.tap(find.byKey(const ValueKey('mark-save')));
      await tester.pumpAndSettle();
      expect(client.saveCalls, isEmpty);

      // A valid value goes through, with the cell's concurrency token.
      await tester.enterText(omarField, '19');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mark-save')));
      await tester.pumpAndSettle();

      expect(client.saveCalls, hasLength(1));
      final entry = client.saveCalls.single.single;
      expect(entry.studentId, 'st-omar');
      expect(entry.score, 19);
      expect(entry.expectedUpdatedAt, '2026-09-10T10:00:00.000Z');
      expect(find.text('Marks saved.'), findsOneWidget);
    });

    testWidgets('a missing mandatory mark is flagged on its row', (
      tester,
    ) async {
      await _pump(
        tester,
        FakeMarkSheetClient(markSheetFixture()),
        home: const AssessmentMarksScreen(
          sheetKey: _key,
          assessmentId: 'a-mid',
        ),
      );

      expect(find.text('Missing'), findsOneWidget); // Omar
      expect(find.text('Exempt from this subject'), findsOneWidget); // Sara
    });

    testWidgets('a concurrent edit asks to reload and drops the local edit', (
      tester,
    ) async {
      final client = FakeMarkSheetClient(markSheetFixture())
        ..saveError = problem(409, 'GRADE_CONCURRENT_EDIT');
      await _pump(
        tester,
        client,
        home: const AssessmentMarksScreen(
          sheetKey: _key,
          assessmentId: 'a-quiz1',
        ),
      );

      await tester.enterText(
        find.byKey(const ValueKey('mark-field-st-omar-1')),
        '12',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mark-save')));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'Someone else changed these marks. Reload to see the latest.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Reload'));
      await tester.pumpAndSettle();

      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('mark-field-st-omar-1')),
      );
      expect(field.controller!.text, '15');
    });

    testWidgets('absent is chosen from the status menu', (tester) async {
      final client = FakeMarkSheetClient(markSheetFixture());
      await _pump(
        tester,
        client,
        home: const AssessmentMarksScreen(
          sheetKey: _key,
          assessmentId: 'a-mid',
        ),
      );

      // Omar's row is the second editable row (Lina, Omar; Sara is exempt).
      await tester.tap(find.byTooltip('Mark status').at(1));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Absent').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mark-save')));
      await tester.pumpAndSettle();

      final entry = client.saveCalls.single.single;
      expect(entry.studentId, 'st-omar');
      expect(entry.status, 'absent');
      expect(entry.score, isNull);
    });
  });

  testWidgets('GradingAssignmentsScreen lists subjects with period states', (
    tester,
  ) async {
    final client = FakeMarkSheetClient(
      markSheetFixture(),
      assignments: [
        GradingAssignment.fromJson({
          'academic_year_id': 'year-1',
          'section_id': 'sec-1',
          'section_name': 'A',
          'grade_level_name': 'Grade 7',
          'subject_id': 'sub-math',
          'subject_name': 'Mathematics',
          'config_id': 'cfg-1',
          'sheets': [
            {'term_id': 't1', 'status': 'returned'},
            {'term_id': 't2', 'status': 'draft'},
          ],
        }),
      ],
    );
    await _pump(tester, client, home: const GradingAssignmentsScreen());

    expect(find.text('Mathematics'), findsOneWidget);
    expect(find.text('Grade 7 · A'), findsOneWidget);
    expect(find.text('Returned: 1'), findsOneWidget);
    expect(find.text('Draft: 1'), findsOneWidget);

    await tester.tap(find.text('Mathematics'));
    await tester.pumpAndSettle();
    expect(find.byType(MarkSheetScreen), findsOneWidget);
  });
}
