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
import 'package:studafy_mobile/src/features/parent/domain/child_timetable.dart';
import 'package:studafy_mobile/src/features/parent/domain/family_finance.dart';
import 'package:studafy_mobile/src/features/parent/presentation/child_detail_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/child_detail_placeholders.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/released_marks_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/subject_grades_card.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/fake_released_marks_client.dart';
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
  FamilyFinanceView? finance,
  ChildTimetable? timetable,
  FakeReleasedMarksClient? marks,
}) {
  return ProviderScope(
    overrides: [
      // An in-memory store so `persistedSelectedChildIdProvider` (and the switcher's persist on
      // tap) has somewhere real to read and write, same as the parent home switcher test.
      offlineDatabaseProvider.overrideWithValue(OfflineDatabase(NativeDatabase.memory())),
      // The Grades tab's recent grades include the child's approved exam marks, from their own
      // endpoint.
      releasedMarksClientProvider.overrideWithValue(marks ?? FakeReleasedMarksClient()),
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
      // The Finance tab is built eagerly along with every other tab (TabBarView keeps every
      // child alive), so this needs a value even in tests that never visit it — otherwise it
      // falls through to the real `apiClientProvider` and fires a live network call.
      familyFinanceProvider.overrideWith((ref) async => finance),
      // Built eagerly with the other tabs too — same reason as the finance override above.
      childTimetableProvider.overrideWith(
        (ref, studentId) async =>
            timetable ?? childTimetableFixture(studentId: studentId),
      ),
    ],
    child: _app(),
  );
}

/// A phone-height surface. The child page now starts with the "Add (child) to this phone" row, so
/// the default 800x600 test surface no longer fits two subject cards or the finance tab's first
/// invoice above the fold.
void _tallScreen(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
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
    _tallScreen(tester);
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

  testWidgets(
      "grades tab: recent grades mix the selected child's exam marks and assignment grades, "
      'each labelled, then separate exam-mark and assignment-grade sections', (tester) async {
    _tallScreen(tester);
    final marks = FakeReleasedMarksClient(periodsByStudent: {
      'child-1': singleReleasedExamPeriods(releasedAt: DateTime.utc(2026, 11, 16)),
      'child-2': singleReleasedExamPeriods(
        releasedAt: DateTime.utc(2026, 11, 15),
        subject: 'Science',
        assessment: 'Lab exam',
        score: 12,
      ),
    });
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1', 'child-2'],
      breakdowns: {
        'child-1': childBreakdown(id: 'child-1', gradeRows: [
          gradeRowJson(
            id: 'g1',
            courseId: 'phys',
            courseName: 'Physics',
            label: 'Lab report',
            publishedAt: '2026-11-10T00:00:00.000Z',
          ),
        ]),
        'child-2': childBreakdown(id: 'child-2', gradeRows: const []),
      },
      marks: marks,
    )));
    await tester.pumpAndSettle();

    final recent = find.byKey(const ValueKey('child-recent-grades-child-1'));
    expect(recent, findsOneWidget);
    expect(find.descendant(of: recent, matching: find.text('Recent grades')), findsOneWidget);
    // Newest first: the exam (16 Nov) above the assignment (10 Nov), each with its kind chip.
    final exam = find.descendant(of: recent, matching: find.text('First month'));
    final assignment = find.descendant(of: recent, matching: find.text('Lab report'));
    expect(tester.getTopLeft(exam).dy, lessThan(tester.getTopLeft(assignment).dy));
    expect(find.descendant(of: recent, matching: find.text('Mathematics · First term')),
        findsOneWidget);
    expect(find.descendant(of: recent, matching: find.text('17.5 / 20')), findsOneWidget);
    expect(find.descendant(of: recent, matching: find.text('Exam')), findsOneWidget);
    expect(find.descendant(of: recent, matching: find.text('Assignment')), findsOneWidget);

    // The two kinds then get sections of their own, exams first, both under the recent list.
    final exams = find.byKey(const ValueKey('child-grades-section-exam'));
    final assignments = find.byKey(const ValueKey('child-grades-section-assignment'));
    expect(find.descendant(of: exams, matching: find.text('Exam marks')), findsOneWidget);
    expect(
      find.descendant(of: assignments, matching: find.text('Assignment grades')),
      findsOneWidget,
    );
    expect(tester.getTopLeft(recent).dy, lessThan(tester.getTopLeft(exams).dy));
    expect(tester.getTopLeft(exams).dy, lessThan(tester.getTopLeft(assignments).dy));
    expect(
      tester.getTopLeft(assignments).dy,
      lessThan(tester.getTopLeft(find.text('Term summary')).dy),
    );

    // An assignment grade is listed right on this tab, so its row opens nothing.
    await tester.tap(assignment);
    await tester.pumpAndSettle();
    expect(find.byType(ReleasedMarksScreen), findsNothing);

    // An exam mark opens the child's marks in full.
    await tester.tap(exam);
    await tester.pumpAndSettle();
    final screen = tester.widget<ReleasedMarksScreen>(find.byType(ReleasedMarksScreen));
    expect([screen.studentId, screen.studentName], ['child-1', 'Amir']);
    expect(find.text('Amir'), findsWidgets);
    await tester.pageBack();
    await tester.pumpAndSettle();

    // So does the Exams section's entry.
    await tester.tap(find.text('See all exam marks'));
    await tester.pumpAndSettle();
    expect(find.byType(ReleasedMarksScreen), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(marks.requestedStudents.toSet(), {'child-1'});

    // Switching child re-scopes the list to that child's marks.
    await tester.tap(find.text('Lina'));
    await tester.pumpAndSettle();
    final lina = find.byKey(const ValueKey('child-recent-grades-child-2'));
    expect(find.descendant(of: lina, matching: find.text('Lab exam')), findsOneWidget);
    expect(find.text('First month'), findsNothing);
    expect(find.text('Lab report'), findsNothing);
    expect(marks.requestedStudents.toSet(), {'child-1', 'child-2'});
  });

  testWidgets('grades tab: recent grades with nothing released or published says so',
      (tester) async {
    _tallScreen(tester);
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {'child-1': childBreakdown(id: 'child-1', gradeRows: const [])},
    )));
    await tester.pumpAndSettle();

    expect(find.text('No exam marks or assignment grades yet.'), findsOneWidget);
    expect(find.text('Exam'), findsNothing);
    expect(find.text('Assignment'), findsNothing);
  });

  testWidgets('grades tab: exam marks still show when the coursework breakdown fails',
      (tester) async {
    _tallScreen(tester);
    final marks = FakeReleasedMarksClient(
      periods: singleReleasedExamPeriods(releasedAt: DateTime.utc(2026, 11, 16)),
    );
    await tester.pumpWidget(wrapWithLocalization(ProviderScope(
      // A failed load stays failed (no retry backoff), so the tab shows its error state.
      retry: (_, _) => null,
      overrides: [
        offlineDatabaseProvider.overrideWithValue(OfflineDatabase(NativeDatabase.memory())),
        releasedMarksClientProvider.overrideWithValue(marks),
        childComparisonProvider.overrideWith(
          (ref) => comparisonReport([childItem(id: 'child-1', name: 'Amir')]),
        ),
        childBreakdownProvider.overrideWith(
          (ref, studentId) async => throw Exception('offline'),
        ),
        familyFinanceProvider.overrideWith((ref) async => null),
        childTimetableProvider.overrideWith(
          (ref, studentId) async => childTimetableFixture(studentId: studentId),
        ),
      ],
      child: _app(),
    )));
    await tester.pumpAndSettle();

    expect(find.text('17.5 / 20'), findsOneWidget);
    expect(find.text("Couldn't load this term's detail."), findsOneWidget);
    expect(find.byType(SubjectGradesCard), findsNothing);
  });

  testWidgets('grades tab: no published grades shows the empty state', (tester) async {
    _tallScreen(tester);
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

  testWidgets("the home's recent grades can bring the detail back to its Grades tab",
      (tester) async {
    _tallScreen(tester);
    await tester.pumpWidget(wrapWithLocalization(_scope(
      childIds: const ['child-1'],
      breakdowns: {'child-1': childBreakdown(id: 'child-1', termAverage: 88)},
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Attendance'));
    await tester.pumpAndSettle();
    expect(find.text('Attendance this term'), findsOneWidget);

    ProviderScope.containerOf(tester.element(find.byType(ChildDetailScreen)))
        .read(childDetailGradesRequestProvider.notifier)
        .request();
    await tester.pumpAndSettle();

    expect(find.text('Term summary'), findsOneWidget);
    expect(find.text('Attendance this term'), findsNothing);
  });

  testWidgets(
    "timetable tab: the child's weekly lessons, with server-resolved names",
    (tester) async {
      await tester.pumpWidget(
        wrapWithLocalization(
          _scope(
            childIds: const ['child-1'],
            breakdowns: {'child-1': childBreakdown(id: 'child-1')},
            timetable: childTimetableFixture(
              slots: [
                childTimetableSlotJson(
                  id: 's1',
                  weekday: DateTime.sunday,
                  period: 1,
                  courseName: 'Science',
                  teacherName: 'Rana Haddad',
                  roomName: 'Lab 2',
                ),
                childTimetableSlotJson(
                  id: 's2',
                  weekday: DateTime.sunday,
                  period: 2,
                  courseName: null,
                  teacherName: null,
                  roomName: null,
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Timetable'));
      await tester.pumpAndSettle();

      // Opens on the first school day (the test clock's weekday is not a school day here) or
      // today; either way switch to Sunday explicitly.
      await tester.tap(find.bySemanticsLabel('Sunday'));
      await tester.pumpAndSettle();

      expect(find.text('Science'), findsOneWidget);
      expect(find.text('Rana Haddad'), findsOneWidget);
      // The endpoint's room is not shown: lessons carry no room.
      expect(find.textContaining('Lab 2'), findsNothing);
      // No course: falls back to the class code.
      expect(find.text('SCI-7A'), findsOneWidget);
    },
  );

  testWidgets('timetable tab: no approved timetable yet', (tester) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        _scope(
          childIds: const ['child-1'],
          breakdowns: {'child-1': childBreakdown(id: 'child-1')},
          timetable: childTimetableFixture(published: false),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Timetable'));
    await tester.pumpAndSettle();

    expect(
      find.text('No timetable has been published for this term yet.'),
      findsOneWidget,
    );
  });

  testWidgets('timetable tab: published but no lessons for this child', (
    tester,
  ) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        _scope(
          childIds: const ['child-1'],
          breakdowns: {'child-1': childBreakdown(id: 'child-1')},
          timetable: childTimetableFixture(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Timetable'));
    await tester.pumpAndSettle();

    expect(
      find.text('No lessons are scheduled for this child yet.'),
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

  group('finance tab', () {
    testWidgets('no household finance data: shows the empty state', (tester) async {
      await tester.pumpWidget(wrapWithLocalization(_scope(
        childIds: const ['child-1'],
        breakdowns: {'child-1': childBreakdown(id: 'child-1')},
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Finance'));
      await tester.pumpAndSettle();

      expect(find.text('No invoices, installments, or receipts yet.'), findsOneWidget);
    });

    testWidgets('renders the balance, an invoice with its pay-online action, an installment, '
        'and a receipt', (tester) async {
      _tallScreen(tester);
      await tester.pumpWidget(wrapWithLocalization(_scope(
        childIds: const ['child-1'],
        breakdowns: {'child-1': childBreakdown(id: 'child-1')},
        finance: FamilyFinanceView(
          sections: [
            financeSection(
              studentId: 'child-1',
              totals: [moneyTotal(minor: 125000, amount: '125.000')],
              invoices: [
                familyInvoice(
                  docname: 'SI-2026-00042',
                  outstandingMinor: 125000,
                  payOnlineUrl: 'https://pay.example.com/checkout?invoice=SI-2026-00042',
                ),
              ],
              installments: [
                familyInstallment(
                  erpnextFeeScheduleId: 'FS-2026-00001',
                  outstandingMinor: 50000,
                  status: InstallmentStatus.overdue,
                ),
              ],
              receipts: [
                familyReceipt(amountMinor: 75000, receiptUrl: 'https://erp.example.com/r.pdf'),
              ],
            ),
          ],
          householdTotals: [moneyTotal(minor: 125000, amount: '125.000')],
          dataAsOf: null,
        ),
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Finance'));
      await tester.pumpAndSettle();

      expect(find.text('125.000 JOD outstanding'), findsOneWidget);
      expect(find.text('SI-2026-00042'), findsOneWidget);
      expect(find.text('Pay online'), findsOneWidget);
      expect(find.text('Overdue'), findsOneWidget);
      expect(find.text('75.000 JOD'), findsOneWidget);
      expect(find.byIcon(Icons.picture_as_pdf_outlined), findsOneWidget);
    });
  });
}
