import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_study_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_explain_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_explain.dart';
import 'package:studafy_mobile/src/features/ai/presentation/explain_screen.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeExplainClient implements AiExplainClient {
  _FakeExplainClient(this.passages);

  final List<AiExplainPassage> passages;
  final explained = <(String, AiExplainLevel)>[];

  @override
  Future<List<AiExplainPassage>> search({
    required String studentId,
    required String topic,
    int limit = 5,
  }) async => passages;

  @override
  Future<String> explain({
    required String studentId,
    required String chunkId,
    required AiExplainLevel level,
  }) async {
    explained.add((chunkId, level));
    return 'Plants make food from sunlight ($chunkId, ${level.name}).';
  }
}

const _passages = [
  AiExplainPassage(
    chunkId: 'chunk-1',
    materialId: 'material-1',
    materialTitle: 'Biology',
    sectionTitle: 'Photosynthesis',
    pageNumber: 4,
    content: 'Photosynthesis converts light energy into chemical energy.',
  ),
  AiExplainPassage(
    chunkId: 'chunk-2',
    materialId: 'material-1',
    materialTitle: 'Biology',
    content: 'Chlorophyll absorbs mostly red and blue light.',
  ),
];

Widget _screen(AiExplainClient client) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        aiExplainClientProvider.overrideWithValue(client),
        askAiStudentIdProvider.overrideWithValue('student-1'),
        aiUsageProvider.overrideWith((ref) async => noAiUsage),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: const ExplainScreen(),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('explains the best passage, then re-explains it at a new level', (tester) async {
    final client = _FakeExplainClient(_passages);
    await tester.pumpWidget(_screen(client));
    await tester.pumpAndSettle();
    expect(find.text('Make any topic easy'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'photosynthesis');
    await tester.pump();
    await tester.tap(find.text('Explain'));
    await tester.pumpAndSettle();

    expect(find.text('Plants make food from sunlight (chunk-1, middle).'), findsOneWidget);
    expect(find.text('Explain a different passage'), findsOneWidget);

    await tester.tap(find.text('Detailed'));
    await tester.pumpAndSettle();

    expect(client.explained, [('chunk-1', AiExplainLevel.middle), ('chunk-1', AiExplainLevel.high)]);
    expect(find.text('Plants make food from sunlight (chunk-1, high).'), findsOneWidget);
  });

  testWidgets('a different passage can be explained instead', (tester) async {
    final client = _FakeExplainClient(_passages);
    await tester.pumpWidget(_screen(client));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'light');
    await tester.pump();
    await tester.tap(find.text('Explain'));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('Chlorophyll absorbs mostly red and blue light.'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Chlorophyll absorbs mostly red and blue light.'));
    await tester.pumpAndSettle();

    expect(client.explained.last, ('chunk-2', AiExplainLevel.middle));
  });

  testWidgets('says so when nothing in the materials matches', (tester) async {
    await tester.pumpWidget(_screen(_FakeExplainClient(const [])));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'quantum chromodynamics');
    await tester.pump();
    await tester.tap(find.text('Explain'));
    await tester.pumpAndSettle();

    expect(find.text('Nothing found on that topic'), findsOneWidget);
  });
}
