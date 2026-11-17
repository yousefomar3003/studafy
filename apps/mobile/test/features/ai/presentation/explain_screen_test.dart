import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_source_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_study_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_explain_client.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_sources_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_explain.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_source.dart';
import 'package:studafy_mobile/src/features/ai/presentation/explain_screen.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeExplainClient implements AiExplainClient {
  _FakeExplainClient(this.passages);

  final List<AiExplainPassage> passages;
  final explained = <(String, AiExplainLevel)>[];
  final searchedIn = <String?>[];

  @override
  Future<List<AiExplainPassage>> search({
    required String studentId,
    required String topic,
    int limit = 5,
    String? materialId,
  }) async {
    searchedIn.add(materialId);
    return passages;
  }

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

class _OwnNotesClient implements AiSourcesClient {
  @override
  Future<AiPersonalSources> list({required String studentId}) async => AiPersonalSources(
    sources: [
      AiPersonalSource(
        id: 'my-notes',
        title: 'My plant notes',
        mimeType: 'image/jpeg',
        sizeBytes: 9000,
        status: AiSourceStatus.ready,
        hasText: true,
        createdAt: DateTime(2026, 11, 1),
      ),
    ],
    usage: AiSourceUsage.empty,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

Widget _screen(AiExplainClient client) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        aiExplainClientProvider.overrideWithValue(client),
        aiSourcesClientProvider.overrideWithValue(_OwnNotesClient()),
        aiSourcePollIntervalProvider.overrideWithValue(Duration.zero),
        currentEnrolledClassIdsProvider.overrideWithValue(const []),
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

  testWidgets('searches only the source the student picks, such as their own notes', (
    tester,
  ) async {
    final client = _FakeExplainClient(_passages);
    await tester.pumpWidget(_screen(client));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('aiExplainChooseScope')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('My files & photos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('My plant notes'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('aiExplainScope')), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'photosynthesis');
    await tester.pump();
    await tester.tap(find.text('Explain'));
    await tester.pumpAndSettle();
    expect(client.searchedIn, ['my-notes']);

    // Clearing the scope searches every study material again.
    final scopeChip = find.byKey(const Key('aiExplainScope'));
    await tester.tap(find.descendant(of: scopeChip, matching: find.byType(Icon)).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Explain'));
    await tester.pumpAndSettle();
    expect(client.searchedIn, ['my-notes', null]);
  });
}
