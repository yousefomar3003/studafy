import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/question_input_question_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/replace_questions_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_assignment_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_assignment_body_status.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/question_editor_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

/// A draft questions assignment with no questions yet, as the composer creates it.
Assignment _draftQuiz() => Assignment.fromJson({
  ...assignmentFixture(id: 'quiz-1', classId: 'class-1', title: 'Capitals quiz').toJson(),
  'kind': 'questions',
  'status': 'draft',
  'assigned_at': null,
  'questions': <Object?>[],
});

/// Records question saves and status changes.
class _QuestionsClient extends FakeAssignmentsClient {
  final List<ReplaceQuestionsBody> replaceCalls = [];
  final List<UpdateAssignmentBody> updateCalls = [];

  @override
  Future<Assignment> replaceAssignmentQuestions({
    required String assignmentId,
    required ReplaceQuestionsBody body,
  }) async {
    replaceCalls.add(body);
    return _draftQuiz();
  }

  @override
  Future<Assignment> updateAssignment({
    required String assignmentId,
    required UpdateAssignmentBody body,
  }) async {
    updateCalls.add(body);
    return _draftQuiz();
  }
}

/// Hosts the editor behind a route, so its pop has somewhere to return to; records the result.
Future<List<bool?>> _pump(WidgetTester tester, _QuestionsClient client) async {
  final results = <bool?>[];
  // Tall enough that the whole form is built; a ListView skips offscreen children.
  tester.view
    ..physicalSize = const Size(800, 3000)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(assignments: client),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () async => results.add(
                    await Navigator.of(context).push<bool>(
                      MaterialPageRoute(
                        builder: (_) =>
                            QuestionEditorScreen(assignment: _draftQuiz()),
                      ),
                    ),
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return results;
}

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'builds a multiple-choice and a true/false question and publishes them',
    (tester) async {
      final client = _QuestionsClient();
      final results = await _pump(tester, client);

      // Question 1: multiple choice, first option correct (the default).
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Capital of France?');
      await tester.enterText(fields.at(1), '2');
      await tester.enterText(fields.at(2), 'Paris');
      await tester.enterText(fields.at(3), 'London');

      // Question 2: true/false, "False" correct.
      await _tapVisible(tester, find.byKey(const Key('questionEditorAdd')));
      await _tapVisible(tester, find.text('True / False').last);
      await tester.enterText(
        find.byType(TextFormField).at(4),
        'Madrid is in Italy.',
      );
      await _tapVisible(tester, find.byKey(const Key('questionOption2-1')));

      await _tapVisible(tester, find.byKey(const Key('questionEditorPublish')));

      final saved = client.replaceCalls.single.questions;
      expect(saved, hasLength(2));
      expect(saved[0].questionType, QuestionInputQuestionType.multipleChoice);
      expect(saved[0].prompt, 'Capital of France?');
      expect(saved[0].points, 2);
      expect(
        [for (final o in saved[0].options) (o.text, o.isCorrect)],
        [('Paris', true), ('London', false)],
      );
      expect(saved[1].questionType, QuestionInputQuestionType.trueFalse);
      expect(
        [for (final o in saved[1].options) (o.text, o.isCorrect)],
        [('True', false), ('False', true)],
      );
      expect(
        client.updateCalls.single.status,
        UpdateAssignmentBodyStatus.published,
      );
      expect(results, [true]);
    },
  );

  testWidgets('does not save a question with an empty option', (tester) async {
    final client = _QuestionsClient();
    await _pump(tester, client);

    await tester.enterText(find.byType(TextFormField).at(0), 'Pick one');
    await tester.enterText(find.byType(TextFormField).at(2), 'Only option');
    await _tapVisible(tester, find.byKey(const Key('questionEditorSave')));

    expect(client.replaceCalls, isEmpty);
    expect(find.text('Enter the option text.'), findsOneWidget);
  });
}
