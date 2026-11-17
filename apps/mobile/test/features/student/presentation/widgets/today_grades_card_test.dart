import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class_value.dart';
import 'package:studafy_mobile/src/core/api/generated/models/course.dart';
import 'package:studafy_mobile/src/core/api/generated/models/cumulative_grade_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade_snapshot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_term_summary.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/application/today_providers.dart';
import 'package:studafy_mobile/src/features/student/application/work_and_grades_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/grade_report.dart';
import 'package:studafy_mobile/src/features/student/domain/today_section.dart';
import 'package:studafy_mobile/src/features/student/domain/work_and_grades.dart';
import 'package:studafy_mobile/src/features/student/presentation/grades_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/today_grades_card.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/today_skeleton.dart';

import '../../../../support/ensure_date_formatting.dart';
import '../../../../support/fake_released_marks_client.dart';
import '../../../../support/wrap_with_localization.dart';

PublishedGrade _grade(String label, String courseName, DateTime publishedAt) {
  return PublishedGrade(
    id: 'grade-$label',
    gradeSubmissionId: 'sub-$label',
    gradebookId: 'gb-$courseName',
    classValue: ClassValue(id: 'class-$courseName', code: '$courseName-A'),
    course: Course(id: 'course-$courseName', code: 'C1', name: courseName, creditHours: 3),
    label: label,
    score: 18,
    maxScore: 20,
    weight: 1,
    percentage: 90,
    gradeLabel: 'A',
    gpaPoints: 4,
    publishedAt: publishedAt,
  );
}

TodaySection<PublishedGradeSnapshot> _ready(List<PublishedGrade> grades, {bool stale = false}) {
  return TodaySectionReady(
    CachedValue(
      data: PublishedGradeSnapshot(
        studentId: 'st-1',
        termId: 'term-1',
        grades: grades,
        termSummary: const PublishedTermSummary(
          termAveragePercentage: null,
          termGpa: null,
          totalCredits: 0,
          calculatedAt: null,
        ),
        cumulativeSummary: const CumulativeGradeSummary(
          cumulativeGpa: null,
          totalCredits: 0,
          throughTermId: 'term-1',
        ),
      ),
      fetchedAt: DateTime(2026, 11, 1),
      source: stale ? CacheSource.cache : CacheSource.network,
    ),
  );
}

Future<void> _pump(
  WidgetTester tester, {
  required FakeReleasedMarksClient marks,
  Stream<TodaySection<PublishedGradeSnapshot>>? grades,
  String? studentId = 'st-1',
  ShellRole shellRole = ShellRole.student,
}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        retry: (_, _) => null,
        overrides: [
          shellRoleProvider.overrideWithValue(shellRole),
          releasedMarksClientProvider.overrideWithValue(marks),
          currentStudentIdProvider.overrideWithValue(studentId),
          todayGradesProvider.overrideWith((ref) => grades ?? Stream.value(_ready(const []))),
          // The Grades screen a row opens outside the student shell; its assignments tab is not
          // under test here.
          academicYearTermsProvider.overrideWith((ref) async => const []),
          gradeReportProvider.overrideWith(
            (ref) => const AsyncData<GradeReportStatus>(GradeReportUnavailable()),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const Scaffold(body: SingleChildScrollView(child: TodayGradesCard())),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// The Grades screen's selected tab, once it is open.
int _selectedTab(WidgetTester tester) =>
    tester.widget<TabBar>(find.byType(TabBar)).controller!.index;

ProviderContainer _container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(TodayGradesCard)));

/// Asserts the last tap asked the shell for the "Work & grades" tab's grades, on [tab].
void _expectGradesTab(WidgetTester tester, GradesTab tab) {
  final container = _container(tester);
  expect(container.read(selectedShellTabProvider), workAndGradesTabKey);
  expect(
    container.read(workAndGradesProvider),
    WorkAndGradesSelection(section: WorkAndGradesSection.grades, gradesTab: tab),
  );
  // Switched to, not pushed.
  expect(find.byType(GradesScreen), findsNothing);
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  final examReleased = DateTime.utc(2026, 11, 16);
  FakeReleasedMarksClient examMarks() =>
      FakeReleasedMarksClient(periods: singleReleasedExamPeriods(releasedAt: examReleased));

  testWidgets('mixes exam marks and assignment grades, newest first, each labelled with its kind', (
    tester,
  ) async {
    final marks = examMarks();
    await _pump(
      tester,
      marks: marks,
      grades: Stream.value(
        _ready([
          _grade('Essay', 'English', DateTime.utc(2026, 11, 17)),
          _grade('Worksheet 3', 'Physics', DateTime.utc(2026, 11, 10)),
        ]),
      ),
    );

    expect(marks.requestedStudents, ['st-1']);
    expect(find.text('Recent grades'), findsOneWidget);
    // No separate exam-marks card any more: the exam is a row of this list.
    expect(find.text('New exam marks'), findsNothing);

    final essay = tester.getTopLeft(find.text('Essay')).dy;
    final exam = tester.getTopLeft(find.text('First month')).dy;
    final worksheet = tester.getTopLeft(find.text('Worksheet 3')).dy;
    expect(essay, lessThan(exam));
    expect(exam, lessThan(worksheet));

    expect(find.text('Exam'), findsOneWidget);
    expect(find.text('Assignment'), findsNWidgets(2));
    expect(find.text('Mathematics · First term'), findsOneWidget);
    expect(find.text('17.5 / 20'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    expect(find.text('18/20'), findsNWidgets(2));
  });

  testWidgets(
    'an exam row opens the Work & grades tab on Exams, an assignment row on Assignments',
    (tester) async {
      await _pump(
        tester,
        marks: examMarks(),
        grades: Stream.value(_ready([_grade('Essay', 'English', DateTime.utc(2026, 11, 10))])),
      );

      await tester.tap(find.text('First month'));
      await tester.pumpAndSettle();
      _expectGradesTab(tester, GradesTab.exams);

      await tester.tap(find.text('Essay'));
      await tester.pumpAndSettle();
      _expectGradesTab(tester, GradesTab.assignments);

      // "View all" lands on the tab of the newest item: the exam here.
      await tester.tap(find.text('View all grades'));
      await tester.pumpAndSettle();
      _expectGradesTab(tester, GradesTab.exams);
    },
  );

  testWidgets('"View all" opens Assignments when the newest item is an assignment grade', (
    tester,
  ) async {
    await _pump(
      tester,
      marks: examMarks(),
      grades: Stream.value(_ready([_grade('Essay', 'English', DateTime.utc(2026, 11, 17))])),
    );

    await tester.tap(find.text('View all grades'));
    await tester.pumpAndSettle();
    _expectGradesTab(tester, GradesTab.assignments);
  });

  testWidgets('outside the student shell a row pushes the Grades screen on its tab', (
    tester,
  ) async {
    await _pump(
      tester,
      shellRole: ShellRole.viewer,
      marks: examMarks(),
      grades: Stream.value(_ready([_grade('Essay', 'English', DateTime.utc(2026, 11, 10))])),
    );

    await tester.tap(find.text('First month'));
    await tester.pumpAndSettle();
    expect(find.byType(GradesScreen), findsOneWidget);
    expect(_selectedTab(tester), GradesTab.exams.index);
    // The full list is right there, with the same mark.
    expect(find.text('17.5 / 20'), findsWidgets);
    await tester.pageBack();
    await tester.pumpAndSettle();

    await tester.tap(find.text('Essay'));
    await tester.pumpAndSettle();
    expect(_selectedTab(tester), GradesTab.assignments.index);
  });

  testWidgets('shows when the only recent grade is an exam mark', (tester) async {
    await _pump(tester, marks: examMarks());

    expect(find.text('First month'), findsOneWidget);
    expect(find.text('Exam'), findsOneWidget);
    expect(find.text('Assignment'), findsNothing);
    expect(find.text('No exam marks or assignment grades yet.'), findsNothing);
  });

  testWidgets('says so when there are neither exam marks nor assignment grades', (tester) async {
    await _pump(tester, marks: FakeReleasedMarksClient());

    expect(find.text('Recent grades'), findsOneWidget);
    expect(find.text('No exam marks or assignment grades yet.'), findsOneWidget);
    // Still the way to the grades, opening on the exams.
    await tester.tap(find.text('View all grades'));
    await tester.pumpAndSettle();
    _expectGradesTab(tester, GradesTab.exams);
  });

  testWidgets('assignment grades still show when the exam marks fail to load', (tester) async {
    await _pump(
      tester,
      marks: FakeReleasedMarksClient(fail: true),
      grades: Stream.value(_ready([_grade('Essay', 'English', DateTime.utc(2026, 11, 10))])),
    );

    expect(find.text('Essay'), findsOneWidget);
    expect(find.text('Assignment'), findsOneWidget);
    expect(find.text('Exam'), findsNothing);
  });

  testWidgets('exam marks still show when the assignment grades fail to load', (tester) async {
    await _pump(tester, marks: examMarks(), grades: Stream.error(Exception('offline')));

    expect(find.text('First month'), findsOneWidget);
    expect(find.text("Couldn't load grades."), findsNothing);
  });

  testWidgets('both failing shows the error', (tester) async {
    await _pump(
      tester,
      marks: FakeReleasedMarksClient(fail: true),
      grades: Stream.error(Exception('offline')),
    );

    expect(find.text("Couldn't load grades."), findsOneWidget);
    expect(find.text('View all grades'), findsOneWidget);
  });

  testWidgets('a stale assignment cache shows the staleness banner above the list', (tester) async {
    await _pump(
      tester,
      marks: examMarks(),
      grades: Stream.value(
        _ready([_grade('Essay', 'English', DateTime.utc(2026, 11, 10))], stale: true),
      ),
    );

    expect(find.textContaining('Showing saved data'), findsOneWidget);
  });

  testWidgets('loads behind a skeleton, and asks for no marks before the student is known', (
    tester,
  ) async {
    final marks = FakeReleasedMarksClient();
    await _pump(
      tester,
      marks: marks,
      studentId: null,
      grades: Stream.value(const TodaySectionUnavailable()),
    );

    expect(marks.requestedStudents, isEmpty);
    expect(find.byType(TodaySkeleton), findsNothing);
    expect(find.text("Grades aren't available yet."), findsOneWidget);
    expect(find.text('View all grades'), findsOneWidget);
  });
}
