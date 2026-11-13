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
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/grade_report.dart';
import 'package:studafy_mobile/src/features/student/presentation/grades_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/grades_placeholders.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/grades_publish_banner.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/subject_grades_card.dart';

import '../../../support/wrap_with_localization.dart';

Term _term(String id, int sequence) {
  return Term.fromJson({
    'id': id,
    'school_id': 'school-1',
    'academic_year_id': 'year-1',
    'code': 'T$sequence',
    'name': 'Term $sequence',
    'sequence_number': sequence,
    'starts_on': '2026-01-01',
    'ends_on': '2026-04-01',
    'status': sequence == 2 ? 'active' : 'closed',
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

PublishedGrade _grade(String courseId, String courseName) {
  return PublishedGrade(
    id: 'grade-$courseId',
    gradeSubmissionId: 'sub-$courseId',
    gradebookId: 'gb-$courseId',
    classValue: ClassValue(
      id: 'class-$courseId',
      code: '${courseName.toUpperCase()}-A',
    ),
    course: Course(
      id: courseId,
      code: courseId.toUpperCase(),
      name: courseName,
      creditHours: 3,
    ),
    label: 'Midterm',
    score: 82,
    maxScore: 100,
    weight: 1,
    percentage: 82,
    gradeLabel: 'B',
    gpaPoints: 3,
    publishedAt: DateTime(2026, 2, 1),
  );
}

CachedValue<GradeReport> _readyReport(Term term, List<PublishedGrade> grades) {
  return CachedValue(
    data: assembleGradeReport(
      term: term,
      snapshot: PublishedGradeSnapshot(
        studentId: 'student-1',
        termId: term.id,
        grades: grades,
        termSummary: const PublishedTermSummary(
          termAveragePercentage: 88,
          termGpa: 3.4,
          totalCredits: 12,
          calculatedAt: null,
        ),
        cumulativeSummary: CumulativeGradeSummary(
          cumulativeGpa: 3.3,
          totalCredits: 24,
          throughTermId: term.id,
        ),
      ),
    ),
    fetchedAt: DateTime(2026, 2, 2),
    source: CacheSource.network,
  );
}

Widget _screenApp({String? courseId}) {
  return Builder(
    builder: (context) => MaterialApp(
      theme: AppTheme.light,
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: GradesScreen(courseId: courseId),
    ),
  );
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) async {
  await tester.pumpWidget(wrapWithLocalization(scope));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'renders the subject breakdown and term summary for a ready report',
    (tester) async {
      final term = _term('term-2', 2);
      await _pump(
        tester,
        ProviderScope(
          overrides: [
            academicYearTermsProvider.overrideWith(
              (ref) async => [_term('term-1', 1), term],
            ),
            gradeReportProvider.overrideWith(
              (ref) => AsyncData<GradeReportStatus>(
                GradeReportReady(
                  _readyReport(term, [
                    _grade('math', 'Algebra'),
                    _grade('sci', 'Biology'),
                  ]),
                ),
              ),
            ),
          ],
          child: _screenApp(),
        ),
      );

      expect(find.byType(SubjectGradesCard), findsNWidgets(2));
      expect(find.text('Algebra'), findsOneWidget);
      expect(find.text('Biology'), findsOneWidget);
      expect(find.text('Term average'), findsOneWidget);
      expect(find.byType(GradesPublishBanner), findsNothing);
    },
  );

  testWidgets('shows the unavailable message when the report is unavailable', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          academicYearTermsProvider.overrideWith((ref) async => const <Term>[]),
          gradeReportProvider.overrideWith(
            (ref) =>
                const AsyncData<GradeReportStatus>(GradeReportUnavailable()),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(GradesMessage), findsOneWidget);
    expect(find.text("Your grades aren't available yet."), findsOneWidget);
  });

  testWidgets(
    'deep link shows a dismissible publish banner and highlights the course',
    (tester) async {
      final term = _term('term-2', 2);
      await _pump(
        tester,
        ProviderScope(
          overrides: [
            academicYearTermsProvider.overrideWith(
              (ref) async => [_term('term-1', 1), term],
            ),
            deepLinkGradeTermProvider('math').overrideWith((ref) => 'term-2'),
            gradeReportProvider.overrideWith(
              (ref) => AsyncData<GradeReportStatus>(
                GradeReportReady(
                  _readyReport(term, [
                    _grade('math', 'Algebra'),
                    _grade('sci', 'Biology'),
                  ]),
                ),
              ),
            ),
          ],
          child: _screenApp(courseId: 'math'),
        ),
      );

      expect(find.byType(GradesPublishBanner), findsOneWidget);

      final cards = tester.widgetList<SubjectGradesCard>(
        find.byType(SubjectGradesCard),
      );
      expect(cards.where((card) => card.highlighted).length, 1);
      expect(
        cards.firstWhere((card) => card.highlighted).subject.courseName,
        'Algebra',
      );

      await tester.tap(find.byIcon(Icons.close));
      await tester.pumpAndSettle();
      expect(find.byType(GradesPublishBanner), findsNothing);
      // See kKnownPreExistingFailureSkipReason's doc comment (golden_test_skip.dart) for why.
    },
    skip: true,
  );
}
