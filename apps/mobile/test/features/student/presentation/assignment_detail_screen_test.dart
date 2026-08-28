import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_grade_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_status.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/assignment_detail_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/assignment_detail_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

const _assignmentId = 'assignment-1';

Assignment _fakeAssignment({
  DateTime? dueAt,
  bool allowLateSubmission = false,
  AssignmentStatus status = AssignmentStatus.published,
}) {
  final now = DateTime(2026, 1, 1);
  return Assignment(
    id: _assignmentId,
    schoolId: 'school-1',
    classId: 'class-1',
    subjectId: 'subject-1',
    title: 'Algebra Worksheet',
    description: 'Chapter 4 exercises.',
    instructions: 'Show your work for every question.',
    status: status,
    availableFrom: null,
    assignedAt: now,
    dueAt: dueAt ?? now.add(const Duration(days: 2)),
    maxScore: 100,
    allowLateSubmission: allowLateSubmission,
    attachments: const [],
    createdByUserId: 'teacher-1',
    lastEditedByUserId: 'teacher-1',
    createdAt: now,
    updatedAt: now,
  );
}

Submission _fakeSubmission({
  bool isLate = false,
  SubmissionGradeStatus gradeStatus = SubmissionGradeStatus.none,
  num? score,
  String? feedback,
}) {
  final now = DateTime(2026, 1, 1);
  return Submission(
    id: 'submission-1',
    schoolId: 'school-1',
    assignmentId: _assignmentId,
    studentId: 'student-1',
    content: 'Here is my answer.',
    status: SubmissionStatus.submitted,
    gradeStatus: gradeStatus,
    isLate: isLate,
    attemptNumber: 1,
    submittedAt: now,
    score: score,
    feedback: feedback,
    gradedAt: gradeStatus == SubmissionGradeStatus.published ? now : null,
    gradedByUserId: gradeStatus == SubmissionGradeStatus.published ? 'teacher-1' : null,
    attachments: const [],
    lastEditedByUserId: 'student-1',
    createdAt: now,
    updatedAt: now,
  );
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) async {
  await tester.pumpWidget(wrapWithLocalization(scope));
  await tester.pumpAndSettle();
}

Widget _screenScope() {
  return Builder(
    builder: (context) {
      return MaterialApp(
        theme: AppTheme.light,
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: const AssignmentDetailScreen(assignmentId: _assignmentId),
      );
    },
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows a submit action and no feedback card when nothing has been handed in', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          assignmentDetailProvider(_assignmentId).overrideWith((ref) async => _fakeAssignment()),
          assignmentSubmissionProvider(_assignmentId).overrideWith((ref) async => null),
        ],
        child: _screenScope(),
      ),
    );

    expect(find.text('You haven\'t submitted this yet.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Submit assignment'), findsOneWidget);
    expect(find.text('Feedback'), findsNothing);
  });

  testWidgets('marks an overdue, unsubmitted assignment as late', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          assignmentDetailProvider(_assignmentId).overrideWith(
            (ref) async => _fakeAssignment(dueAt: DateTime.now().subtract(const Duration(days: 1))),
          ),
          assignmentSubmissionProvider(_assignmentId).overrideWith((ref) async => null),
        ],
        child: _screenScope(),
      ),
    );

    expect(find.text('Late'), findsOneWidget);
  });

  testWidgets('renders the teacher\'s feedback once the grade is published', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          assignmentDetailProvider(_assignmentId).overrideWith((ref) async => _fakeAssignment()),
          assignmentSubmissionProvider(_assignmentId).overrideWith(
            (ref) async => _fakeSubmission(
              gradeStatus: SubmissionGradeStatus.published,
              score: 92,
              feedback: 'Great work, watch your signs in question 3.',
            ),
          ),
        ],
        child: _screenScope(),
      ),
    );

    expect(find.text('Feedback'), findsOneWidget);
    expect(find.text('92'), findsOneWidget);
    expect(find.text('Great work, watch your signs in question 3.'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Resubmit'), findsOneWidget);
  });

  testWidgets('shows "awaiting grade" and a late pill for an unmarked late submission', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          assignmentDetailProvider(
            _assignmentId,
          ).overrideWith((ref) async => _fakeAssignment(allowLateSubmission: true)),
          assignmentSubmissionProvider(
            _assignmentId,
          ).overrideWith((ref) async => _fakeSubmission(isLate: true)),
        ],
        child: _screenScope(),
      ),
    );

    expect(find.text('Awaiting grade.'), findsOneWidget);
    expect(find.text('Late'), findsOneWidget);
  });
}
