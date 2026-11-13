import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment_question.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_submission_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_answer.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/presentation/question_answer_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/answer_review.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../../teacher/support.dart';

Map<String, Object?> _question(String id, int position, List<String> options) =>
    {
      'id': id,
      'position': position,
      'question_type': options.length == 2 ? 'true_false' : 'multiple_choice',
      'prompt': 'Question $position',
      'points': 1,
      'options': [
        for (final (index, text) in options.indexed)
          {
            'id': '$id-o$index',
            'position': index + 1,
            'text': text,
            'is_correct': null,
          },
      ],
    };

/// A published questions assignment as a student receives it: no answer key.
Assignment _quiz() => Assignment.fromJson({
  ...assignmentFixture(
    id: 'quiz-1',
    classId: 'class-1',
    title: 'Cells quiz',
  ).toJson(),
  'kind': 'questions',
  'max_score': 2,
  'questions': [
    _question('q1', 1, ['Nucleus', 'Chloroplast', 'Ribosome']),
    _question('q2', 2, ['True', 'False']),
  ],
});

class _RecordingSubmissions extends FakeSubmissionsClient {
  final List<CreateSubmissionBody> createCalls = [];

  @override
  Future<Submission> createSubmission({
    required String assignmentId,
    required CreateSubmissionBody body,
  }) async {
    createCalls.add(body);
    // Marked and released as it lands, as the API does for a questions hand-in.
    return submissionFixture(
      id: 'sub-1',
      assignmentId: assignmentId,
      studentId: 'student-1',
      status: 'graded',
      gradeStatus: 'published',
      score: 1,
    );
  }
}

Future<void> _pumpHost(
  WidgetTester tester,
  Widget home, {
  _RecordingSubmissions? submissions,
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(submissions: submissions),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
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

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('submits one answer per question once all are answered', (
    tester,
  ) async {
    final submissions = _RecordingSubmissions();
    await _pumpHost(
      tester,
      Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => QuestionAnswerScreen(assignment: _quiz()),
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
      submissions: submissions,
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    final submit = find.byKey(const Key('questionAnswersSubmit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    await _tapVisible(tester, find.byKey(const Key('answer-q1-q1-o1')));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await _tapVisible(tester, find.byKey(const Key('answer-q2-q2-o1')));
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);

    await _tapVisible(tester, submit);

    final answers = submissions.createCalls.single.answers!;
    expect(
      [for (final a in answers) (a.questionId, a.optionId)],
      [('q1', 'q1-o1'), ('q2', 'q2-o1')],
    );

    // The grade, straight away.
    expect(find.byKey(const Key('questionResultDialog')), findsOneWidget);
    expect(find.text('1 / 2'), findsOneWidget);
    expect(find.text('50%'), findsOneWidget);

    await _tapVisible(tester, find.byKey(const Key('questionResultDone')));
    expect(find.text('open'), findsOneWidget);
  });

  testWidgets('shows only the student\'s choice until the mark is released', (
    tester,
  ) async {
    final questions = _quiz().questions;
    await _pumpHost(
      tester,
      Scaffold(
        body: SingleChildScrollView(
          child: AnswerReview(
            questions: questions,
            answers: const [
              SubmissionAnswer(
                questionId: 'q1',
                optionId: 'q1-o0',
                isCorrect: null,
                correctOptionId: null,
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('Your answer'), findsOneWidget);
    expect(find.text('Correct'), findsNothing);
    expect(find.text('Right answer'), findsNothing);
    expect(find.text('Not answered'), findsOneWidget);
  });

  testWidgets('shows right and wrong answers once the mark is released', (
    tester,
  ) async {
    final List<AssignmentQuestion> questions = _quiz().questions;
    await _pumpHost(
      tester,
      Scaffold(
        body: SingleChildScrollView(
          child: AnswerReview(
            questions: questions,
            answers: const [
              SubmissionAnswer(
                questionId: 'q1',
                optionId: 'q1-o0',
                isCorrect: false,
                correctOptionId: 'q1-o1',
              ),
              SubmissionAnswer(
                questionId: 'q2',
                optionId: 'q2-o1',
                isCorrect: true,
                correctOptionId: 'q2-o1',
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('Incorrect'), findsOneWidget);
    expect(find.text('Right answer'), findsOneWidget);
    expect(find.text('Correct'), findsOneWidget);
  });
}
