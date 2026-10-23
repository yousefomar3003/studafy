import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/assignment_submissions_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/submission_marking_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

final _assignment = assignmentFixture(
  id: 'a-1',
  classId: 'class-1',
  title: 'Worksheet',
);

FakeStudafyApiClient _api(FakeSubmissionsClient submissions) =>
    FakeStudafyApiClient(
      submissions: submissions,
      academics: FakeAcademicsClient(
        enrollmentsByClassId: {
          'class-1': [
            enrollmentFixture(studentId: 'student-1'),
            enrollmentFixture(studentId: 'student-2'),
            enrollmentFixture(studentId: 'student-3'),
          ],
        },
      ),
    );

Future<void> _pump(
  WidgetTester tester,
  FakeStudafyApiClient api,
  Widget home,
) async {
  tester.view
    ..physicalSize = const Size(400, 1400)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          classRosterNamesProvider.overrideWith(
            (ref, classId) async => const {},
          ),
          rosterStudentNameProvider.overrideWith(
            (ref, studentId) => {
              'student-1': 'Ali',
              'student-2': 'Sara',
              'student-3': 'Omar',
            }[studentId],
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: home,
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
    'lists the whole roster and publishes every ready draft mark at once',
    (tester) async {
      final submissions = FakeSubmissionsClient(
        byAssignmentId: {
          'a-1': [
            submissionFixture(
              id: 's-1',
              assignmentId: 'a-1',
              studentId: 'student-1',
              isLate: true,
            ),
            submissionFixture(
              id: 's-2',
              assignmentId: 'a-1',
              studentId: 'student-2',
              gradeStatus: 'draft',
              score: 80,
              feedback: 'Good',
            ),
          ],
        },
      );
      await _pump(
        tester,
        _api(submissions),
        AssignmentSubmissionsScreen(assignment: _assignment),
      );

      expect(find.text('2 of 3 students have handed in.'), findsOneWidget);
      expect(find.text('To mark'), findsOneWidget);
      expect(find.text('Late'), findsOneWidget);
      expect(find.text('Draft mark'), findsOneWidget);
      expect(find.text('Not handed in'), findsOneWidget);
      expect(find.text('Omar'), findsOneWidget);

      await tester.tap(find.byKey(const Key('publishReadyMarks')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
      await tester.pumpAndSettle();

      expect(submissions.gradeCalls.map((call) => call.$1), ['s-2']);
      expect(submissions.gradeCalls.single.$2, {
        'score': 80,
        'feedback': 'Good',
        'publish': true,
        'return_to_student': false,
      });
    },
  );

  testWidgets('publishes a mark with feedback after confirming', (
    tester,
  ) async {
    final submissions = FakeSubmissionsClient(
      byAssignmentId: {
        'a-1': [
          submissionFixture(
            id: 's-1',
            assignmentId: 'a-1',
            studentId: 'student-1',
          ),
        ],
      },
    );
    await _pump(
      tester,
      _api(submissions),
      SubmissionMarkingScreen(
        assignment: _assignment,
        submissionId: 's-1',
        studentName: 'Ali',
      ),
    );

    await tester.enterText(find.byKey(const Key('markingScore')), '85');
    await tester.enterText(
      find.byKey(const Key('markingFeedback')),
      'Nice work',
    );
    await tester.tap(find.byKey(const Key('markingPublish')));
    await tester.pumpAndSettle();
    expect(find.text('Publish this mark?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
    await tester.pumpAndSettle();

    expect(submissions.gradeCalls.map((call) => call.$1), ['s-1']);
    expect(submissions.gradeCalls.single.$2, {
      'score': 85,
      'feedback': 'Nice work',
      'publish': true,
      'return_to_student': false,
    });
  });

  testWidgets('refuses a score over the maximum without calling the API', (
    tester,
  ) async {
    final submissions = FakeSubmissionsClient(
      byAssignmentId: {
        'a-1': [
          submissionFixture(
            id: 's-1',
            assignmentId: 'a-1',
            studentId: 'student-1',
          ),
        ],
      },
    );
    await _pump(
      tester,
      _api(submissions),
      SubmissionMarkingScreen(
        assignment: _assignment,
        submissionId: 's-1',
        studentName: 'Ali',
      ),
    );

    await tester.enterText(find.byKey(const Key('markingScore')), '120');
    await tester.tap(find.byKey(const Key('markingSaveDraft')));
    await tester.pumpAndSettle();

    expect(find.text('Enter a score from 0 to 100.'), findsOneWidget);
    expect(submissions.gradeCalls, isEmpty);
  });

  testWidgets('returns unscored work without sending a null score', (
    tester,
  ) async {
    final submissions = FakeSubmissionsClient(
      byAssignmentId: {
        'a-1': [
          submissionFixture(
            id: 's-1',
            assignmentId: 'a-1',
            studentId: 'student-1',
          ),
        ],
      },
    );
    await _pump(
      tester,
      _api(submissions),
      SubmissionMarkingScreen(
        assignment: _assignment,
        submissionId: 's-1',
        studentName: 'Ali',
      ),
    );

    await tester.ensureVisible(find.byKey(const Key('markingReturn')));
    await tester.tap(find.byKey(const Key('markingReturn')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Return'));
    await tester.pumpAndSettle();

    expect(submissions.gradeCalls.map((call) => call.$1), ['s-1']);
    expect(submissions.gradeCalls.single.$2, {
      'feedback': null,
      'publish': false,
      'return_to_student': true,
    });
  });
}
