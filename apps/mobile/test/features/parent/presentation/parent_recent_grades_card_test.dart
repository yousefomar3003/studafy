import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_item.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_recent_grade.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/parent_recent_grades_card.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/parent_section_card.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/released_marks_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/fake_released_marks_client.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

final _amirExam = recentGrade(
  kind: 'exam',
  id: 'a-first-month',
  studentId: 'child-1',
  firstName: 'Amir',
  name: 'First month',
  termName: 'First term',
  releasedAt: '2026-11-16T09:00:00.000Z',
);
final _linaEssay = recentGrade(
  kind: 'assignment',
  id: 'g-essay',
  studentId: 'child-2',
  firstName: 'Lina',
  name: 'Essay',
  subject: 'English',
  releasedAt: '2026-11-17T09:00:00.000Z',
  score: 18,
);

/// The card on its own, with [items] as the family's recent grades and [children] linked.
Future<ProviderContainer> _pump(
  WidgetTester tester, {
  required Future<List<ChildRecentGrade>> Function() items,
  List<ChildComparisonItem>? children,
}) async {
  tester.view
    ..physicalSize = const Size(390, 1400)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final scope = ProviderScope(
    retry: (_, _) => null,
    overrides: [
      offlineDatabaseProvider.overrideWithValue(OfflineDatabase(NativeDatabase.memory())),
      parentRecentGradesProvider.overrideWith((ref) => items()),
      childComparisonProvider.overrideWith(
        (ref) async => comparisonReport(
          children ??
              [childItem(id: 'child-1', name: 'Amir'), childItem(id: 'child-2', name: 'Lina')],
        ),
      ),
      // The marks screen an exam row opens.
      releasedMarksClientProvider.overrideWithValue(FakeReleasedMarksClient()),
    ],
    child: Builder(
      builder: (context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: const Scaffold(body: SingleChildScrollView(child: ParentRecentGradesCard())),
      ),
    ),
  );
  await tester.pumpWidget(wrapWithLocalization(scope));
  await tester.pumpAndSettle();
  return ProviderScope.containerOf(tester.element(find.byType(ParentRecentGradesCard)));
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('lists the family\'s newest marks in order, each labelled, with the child\'s name', (
    tester,
  ) async {
    await _pump(tester, items: () async => [_linaEssay, _amirExam]);

    expect(find.text('Recent grades'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Essay')).dy,
      lessThan(tester.getTopLeft(find.text('First month')).dy),
    );
    expect(find.text('Assignment'), findsOneWidget);
    expect(find.text('Exam'), findsOneWidget);
    // Two children, so each row says whose it is.
    expect(find.text('Lina · English'), findsOneWidget);
    expect(find.text('Amir · Mathematics · First term'), findsOneWidget);
    expect(find.text('18/20'), findsOneWidget);
    expect(find.text('17.5 / 20'), findsOneWidget);
  });

  testWidgets('a parent of one child is not told the name on every row', (tester) async {
    await _pump(
      tester,
      items: () async => [_amirExam],
      children: [childItem(id: 'child-1', name: 'Amir')],
    );

    expect(find.text('Mathematics · First term'), findsOneWidget);
    expect(find.textContaining('Amir'), findsNothing);
  });

  testWidgets('a retake and an absence read as such', (tester) async {
    await _pump(
      tester,
      items: () async => [
        recentGrade(
          kind: 'exam',
          id: 'a-1',
          studentId: 'child-1',
          firstName: 'Amir',
          name: 'Midterm',
          attempt: 2,
          score: 15,
        ),
        recentGrade(
          kind: 'exam',
          id: 'a-2',
          studentId: 'child-2',
          firstName: 'Lina',
          name: 'Final',
          status: 'absent',
          score: null,
        ),
      ],
    );

    expect(find.text('Midterm (retake)'), findsOneWidget);
    expect(find.text('Absent'), findsOneWidget);
  });

  testWidgets("an exam opens that child's exam marks", (tester) async {
    await _pump(tester, items: () async => [_amirExam]);

    await tester.tap(find.text('First month'));
    await tester.pumpAndSettle();

    final screen = tester.widget<ReleasedMarksScreen>(find.byType(ReleasedMarksScreen));
    expect([screen.studentId, screen.studentName], ['child-1', 'Amir Test']);
  });

  testWidgets("an assignment grade switches to the Children tab on that child's Grades", (
    tester,
  ) async {
    final container = await _pump(tester, items: () async => [_linaEssay]);
    expect(container.read(childDetailGradesRequestProvider), 0);

    await tester.tap(find.text('Essay'));
    await tester.pumpAndSettle();

    expect(container.read(selectedChildProvider).value?.studentId, 'child-2');
    expect(container.read(selectedShellTabProvider), 'shell.tabs.children');
    expect(container.read(childDetailGradesRequestProvider), 1);
  });

  testWidgets('says so when there is nothing yet', (tester) async {
    await _pump(tester, items: () async => const []);

    expect(find.text('Recent grades'), findsOneWidget);
    expect(find.text('No exam marks or assignment grades yet.'), findsOneWidget);
  });

  testWidgets('takes no room when the marks cannot load', (tester) async {
    await _pump(tester, items: () async => throw Exception('offline'));

    expect(find.text('Recent grades'), findsNothing);
    expect(find.byType(ParentSectionCard), findsNothing);
  });
}
