import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/grade_entry_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/grade_entry_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/grade_entry.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/create_assessment_sheet.dart';

import '../../../../support/wrap_with_localization.dart';

/// Records createAssessment; nothing else is reached from the sheet.
class _FakeGradeEntryClient implements GradeEntryClient {
  final List<(String, double)> created = [];

  @override
  Future<List<GradeSubmission>> createAssessment(
    String gradebookId, {
    required String label,
    required double maxScore,
    double weight = 1,
  }) async {
    created.add((label, maxScore));
    return const [];
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<_FakeGradeEntryClient> _pump(WidgetTester tester) async {
  final client = _FakeGradeEntryClient();
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [gradeEntryClientProvider.overrideWithValue(client)],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const Scaffold(
              body: CreateAssessmentSheet(gradebookId: 'gb-1'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return client;
}

void main() {
  testWidgets('the max score starts empty with a hint, and is required', (
    tester,
  ) async {
    final client = await _pump(tester);
    final maxScore = find.byType(TextFormField).at(1);

    expect(tester.widget<TextFormField>(maxScore).controller!.text, isEmpty);
    expect(find.text('Out of how many points?'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField).at(0), 'Quiz 1');
    await tester.tap(find.text('Add assessment'));
    await tester.pumpAndSettle();
    expect(client.created, isEmpty);
    expect(find.text('Enter a number above 0.'), findsOneWidget);

    await tester.enterText(maxScore, '20');
    await tester.tap(find.text('Add assessment'));
    await tester.pumpAndSettle();
    expect(client.created, [('Quiz 1', 20.0)]);
  });
}
