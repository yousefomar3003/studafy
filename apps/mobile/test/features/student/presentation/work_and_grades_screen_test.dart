import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/kit/kit.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/assignment_list_providers.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/application/work_and_grades_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/grade_report.dart';
import 'package:studafy_mobile/src/features/student/domain/work_and_grades.dart';
import 'package:studafy_mobile/src/features/student/presentation/work_and_grades_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/fake_released_marks_client.dart';
import '../../../support/wrap_with_localization.dart';

Future<ProviderContainer> _pump(
  WidgetTester tester, {
  required FakeReleasedMarksClient marks,
  Locale locale = const Locale('en'),
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final container = ProviderContainer(
    retry: (_, _) => null,
    overrides: [
      releasedMarksClientProvider.overrideWithValue(marks),
      currentStudentIdProvider.overrideWithValue('st-1'),
      studentAssignmentsProvider.overrideWith((ref, filter) async => const []),
      academicYearTermsProvider.overrideWith((ref) async => const []),
      gradeReportProvider.overrideWith(
        (ref) => const AsyncData<GradeReportStatus>(GradeReportUnavailable()),
      ),
    ],
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    wrapWithLocalization(
      startLocale: locale,
      UncontrolledProviderScope(
        container: container,
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const WorkAndGradesScreen(),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

/// The selected tab of the visible tab bar (the hidden section's stays mounted, but not hittable).
int _visibleTab(WidgetTester tester) =>
    tester.widget<TabBar>(find.byType(TabBar).hitTestable()).controller!.index;

Finder _segment(String label) => find.descendant(
  of: find.byType(AppSegmentedToggle<WorkAndGradesSection>),
  matching: find.text(label),
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  FakeReleasedMarksClient examMarks() => FakeReleasedMarksClient(
    periods: singleReleasedExamPeriods(releasedAt: DateTime.utc(2026, 11, 16)),
  );

  testWidgets('opens on the assignments, and loads no grades until they are shown', (tester) async {
    final marks = examMarks();
    await _pump(tester, marks: marks);

    expect(_segment('Assignments'), findsOneWidget);
    expect(_segment('Grades'), findsOneWidget);
    for (final tab in ['Due', 'Submitted', 'Graded']) {
      expect(find.text(tab).hitTestable(), findsOneWidget);
    }
    expect(find.text('Nothing due right now.'), findsOneWidget);
    expect(marks.requestedStudents, isEmpty);
    // The official-results entry comes with the grades.
    expect(find.byTooltip('Official results'), findsNothing);
  });

  testWidgets('the Grades section shows exams and assignment grades, and is remembered', (
    tester,
  ) async {
    final marks = examMarks();
    final container = await _pump(tester, marks: marks);

    await tester.tap(_segment('Grades'));
    await tester.pumpAndSettle();

    expect(container.read(workAndGradesProvider).section, WorkAndGradesSection.grades);
    expect(marks.requestedStudents, ['st-1']);
    expect(find.text('Exams').hitTestable(), findsOneWidget);
    // "Assignments" is the other section, so the coursework grades tab says what it holds.
    expect(find.text('Assignment grades').hitTestable(), findsOneWidget);
    expect(find.byTooltip('Official results'), findsOneWidget);
    expect(_visibleTab(tester), GradesTab.exams.index);
    expect(find.text('First month').hitTestable(), findsWidgets);
    // The assignment list is out of sight.
    expect(find.text('Due').hitTestable(), findsNothing);

    await tester.tap(find.text('Assignment grades'));
    await tester.pumpAndSettle();
    expect(container.read(workAndGradesProvider).gradesTab, GradesTab.assignments);

    // Back to the assignments and over again: still on the assignment grades.
    await tester.tap(_segment('Assignments'));
    await tester.pumpAndSettle();
    expect(find.text('Due').hitTestable(), findsOneWidget);
    expect(container.read(workAndGradesProvider).section, WorkAndGradesSection.assignments);

    await tester.tap(_segment('Grades'));
    await tester.pumpAndSettle();
    expect(_visibleTab(tester), GradesTab.assignments.index);
  });

  testWidgets('a request for the grades (the home card) opens them on the asked-for tab', (
    tester,
  ) async {
    final container = await _pump(tester, marks: examMarks());

    container.read(workAndGradesProvider.notifier).showGrades(GradesTab.assignments);
    await tester.pumpAndSettle();
    expect(find.text('Assignment grades').hitTestable(), findsOneWidget);
    expect(_visibleTab(tester), GradesTab.assignments.index);

    container.read(workAndGradesProvider.notifier).showGrades(GradesTab.exams);
    await tester.pumpAndSettle();
    expect(_visibleTab(tester), GradesTab.exams.index);
  });

  testWidgets('in Arabic the sections read right to left', (tester) async {
    await _pump(tester, marks: examMarks(), locale: const Locale('ar'));

    final assignments = _segment('الواجبات');
    final grades = _segment('الدرجات');
    expect(assignments, findsOneWidget);
    expect(grades, findsOneWidget);
    expect(tester.getCenter(assignments).dx, greaterThan(tester.getCenter(grades).dx));

    await tester.tap(grades);
    await tester.pumpAndSettle();
    expect(find.text('درجات الواجبات').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('each section is a labelled, selectable button for screen readers', (tester) async {
    final handle = tester.ensureSemantics();
    await _pump(tester, marks: examMarks());

    expect(
      tester.getSemantics(_segment('Assignments')),
      isSemantics(
        label: 'Assignments',
        isButton: true,
        hasSelectedState: true,
        isSelected: true,
        isInMutuallyExclusiveGroup: true,
        hasTapAction: true,
      ),
    );
    expect(
      tester.getSemantics(_segment('Grades')),
      isSemantics(
        label: 'Grades',
        isButton: true,
        hasSelectedState: true,
        isSelected: false,
        isInMutuallyExclusiveGroup: true,
        hasTapAction: true,
      ),
    );
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
    handle.dispose();
  });

  test('the tab key is the one the shell and notifications use', () {
    expect(workAndGradesTabKey, 'shell.tabs.workAndGrades');
  });
}
