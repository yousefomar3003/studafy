import 'dart:async';

import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_breakdown.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/child_detail_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/presentation/child_detail_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/child_detail_placeholders.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/subject_grades_card.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Widget _app() {
  return Builder(
    builder: (context) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: const Scaffold(body: ChildDetailScreen()),
    ),
  );
}

ProviderScope _scope({
  required List<String> childIds,
  required Map<String, ChildComparisonBreakdown> breakdowns,
}) {
  return ProviderScope(
    overrides: [
      // An in-memory store so `persistedSelectedChildIdProvider` (and the switcher's persist on
      // tap) has somewhere real to read and write, same as the parent home switcher test.
      offlineDatabaseProvider.overrideWithValue(OfflineDatabase(NativeDatabase.memory())),
      childComparisonProvider.overrideWith(
        (ref) => comparisonReport([
          for (final id in childIds) childItem(id: id, name: id == 'child-1' ? 'Amir' : 'Lina'),
        ]),
      ),
      childBreakdownProvider.overrideWith((ref, studentId) async {
        final breakdown = breakdowns[studentId];
        if (breakdown == null) return Completer<ChildComparisonBreakdown>().future;
        return breakdown;
      }),
    ],
    child: _app(),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('no linked children: shows the empty message, no tabs', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(
      ProviderScope(
        overrides: [
          childComparisonProvider.overrideWith((ref) => comparisonReport(const [])),
        ],
        child: _app(),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('No children are linked to your account yet.'), findsOneWidget);
    expect(find.byType(TabBar), findsNothing);
  });

  testWidgets('grades tab: term summary and one card per subject, reusing SubjectGradesCard',
      (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {
        'child-1': childBreakdown(
          id: 'child-1',
          termAverage: 88,
          termGpa: 3.4,
          gradeRows: [
            gradeRowJson(id: 'g1', courseId: 'phys', courseName: 'Physics'),
            gradeRowJson(id: 'g2', courseId: 'alg', courseName: 'Algebra'),
          ],
        ),
      },
    )));
    await tester.pumpAndSettle();

    expect(find.text('Term summary'), findsOneWidget);
    expect(find.text('88%'), findsOneWidget);
    expect(find.byType(SubjectGradesCard), findsNWidgets(2));
  });

  testWidgets('grades tab: no published grades shows the empty state', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {'child-1': childBreakdown(id: 'child-1', gradeRows: const [])},
    )));
    await tester.pumpAndSettle();

    expect(find.text('No grades published this term yet.'), findsOneWidget);
  });

  testWidgets('attendance tab: totals breakdown and alert badge', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {
        'child-1': childBreakdown(
          id: 'child-1',
          totalRecords: 40,
          absentCount: 6,
          absentPercent: 15,
          weeklyPresentPercents: const [100, 80],
        ),
      },
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Attendance'));
    await tester.pumpAndSettle();

    expect(find.text('Attendance this term'), findsOneWidget);
    expect(find.text('6 (15%)'), findsOneWidget);
    expect(find.text('Needs attention'), findsOneWidget);
    expect(find.text('Weekly present rate'), findsOneWidget);
  });

  testWidgets('timetable tab: honest unavailable state', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {'child-1': childBreakdown(id: 'child-1')},
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Timetable'));
    await tester.pumpAndSettle();

    expect(
      find.text("The weekly timetable isn't available in the family view yet."),
      findsOneWidget,
    );
  });

  testWidgets('assignments tab: completion breakdown', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {
        'child-1': childBreakdown(
          id: 'child-1',
          assignmentsTotal: 10,
          submitted: 9,
          onTime: 8,
          late: 1,
        ),
      },
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Assignments'));
    await tester.pumpAndSettle();

    expect(find.text('Assignment completion'), findsOneWidget);
    expect(find.text('90%'), findsOneWidget);
    expect(find.text('9/10'), findsOneWidget);
  });

  testWidgets('more than one child: the switcher bar swaps the scoped child', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1', 'child-2'],
      breakdowns: {
        'child-1': childBreakdown(id: 'child-1', termAverage: 88),
        'child-2': childBreakdown(id: 'child-2', termAverage: 61),
      },
    )));
    await tester.pumpAndSettle();

    // Defaults to the first linked child.
    expect(find.text('88%'), findsOneWidget);

    await tester.tap(find.text('Lina'));
    await tester.pumpAndSettle();

    expect(find.text('61%'), findsOneWidget);
  });

  testWidgets('breakdown still loading: shows the skeleton', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: const {},
    )));
    await tester.pump();

    expect(find.byType(ChildDetailSkeleton), findsOneWidget);
  });
}
