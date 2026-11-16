import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/grade_report.dart';
import 'package:studafy_mobile/src/features/student/presentation/grades_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/today_new_marks_card.dart';

import '../../../../support/ensure_date_formatting.dart';
import '../../../../support/fake_released_marks_client.dart';
import '../../../../support/wrap_with_localization.dart';

final _now = DateTime.utc(2026, 11, 17, 9);

Future<void> _pump(
  WidgetTester tester,
  FakeReleasedMarksClient client, {
  String? studentId = 'st-1',
}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        retry: (_, _) => null,
        overrides: [
          releasedMarksClientProvider.overrideWithValue(client),
          currentStudentIdProvider.overrideWithValue(studentId),
          // The Grades screen "See all" opens; its coursework tab is not under test.
          academicYearTermsProvider.overrideWith((ref) async => const []),
          gradeReportProvider.overrideWith(
            (ref) =>
                const AsyncData<GradeReportStatus>(GradeReportUnavailable()),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: Scaffold(
              body: ListView(
                children: [
                  TodayNewMarksCard(now: _now),
                  const Text('next card'),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'a mark released this week shows on the home and opens the Exam marks tab',
    (tester) async {
      final client = FakeReleasedMarksClient(
        periods: singleReleasedExamPeriods(
          releasedAt: _now.subtract(const Duration(days: 1)),
        ),
      );
      await _pump(tester, client);

      expect(client.requestedStudents, ['st-1']);
      expect(find.text('New exam marks'), findsOneWidget);
      expect(find.text('First month'), findsOneWidget);
      expect(find.text('Mathematics · First term'), findsOneWidget);
      expect(find.text('17.5 / 20'), findsOneWidget);
      expect(
        find.text('More marks for this term are still to come.'),
        findsOneWidget,
      );

      await tester.tap(find.text('See all exam marks'));
      await tester.pumpAndSettle();
      expect(find.byType(GradesScreen), findsOneWidget);
      final tabs = DefaultTabController.of(
        tester.element(find.byKey(const ValueKey('grades-tab-exam-marks'))),
      );
      expect(tabs.index, GradesTab.examMarks.index);
      // The full list is right there, with the same mark.
      expect(find.text('17.5 / 20'), findsWidgets);
    },
  );

  testWidgets('takes no room when nothing was released in the last two weeks', (
    tester,
  ) async {
    final client = FakeReleasedMarksClient(
      periods: singleReleasedExamPeriods(
        releasedAt: _now.subtract(const Duration(days: 30)),
      ),
    );
    await _pump(tester, client);

    expect(find.text('New exam marks'), findsNothing);
    expect(
      tester.getTopLeft(find.text('next card')).dy,
      0,
      reason: 'no leftover spacing above the next card',
    );
  });

  testWidgets('hidden when no marks were released yet', (tester) async {
    await _pump(tester, FakeReleasedMarksClient());
    expect(find.text('New exam marks'), findsNothing);
  });

  testWidgets('hidden when the marks fail to load', (tester) async {
    await _pump(tester, FakeReleasedMarksClient(fail: true));
    expect(find.text('New exam marks'), findsNothing);
    expect(find.text("Couldn't load marks."), findsNothing);
  });

  testWidgets('asks for nothing before the student is known', (tester) async {
    final client = FakeReleasedMarksClient();
    await _pump(tester, client, studentId: null);
    expect(find.text('New exam marks'), findsNothing);
    expect(client.requestedStudents, isEmpty);
  });
}
