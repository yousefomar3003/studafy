import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_client.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_events.dart';
import 'package:studafy_mobile/src/features/ai/domain/ask_ai_conversation.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ask_ai_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ask_ai_citation_chip.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeAskAiClient implements AskAiClient {
  _FakeAskAiClient(this._events);

  final Stream<AskAiEvent> Function() _events;

  @override
  Stream<AskAiEvent> ask({
    required String studentId,
    required String question,
    String? conversationId,
    String level = 'high',
  }) => _events();

  @override
  Future<AskAiReportOutcome> report({
    required String studentId,
    required String messageId,
    required String reason,
  }) async => AskAiReportOutcome.filed;
}

Widget _screen({required AskAiClient client, String? studentId = 'student-1'}) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        askAiClientProvider.overrideWithValue(client),
        askAiStudentIdProvider.overrideWithValue(studentId),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: const AskAiScreen(),
        ),
      ),
    ),
  );
}

Future<void> _ask(WidgetTester tester, String question) async {
  await tester.enterText(find.byType(TextField).first, question);
  await tester.pump();
  await tester.tap(find.byIcon(Icons.send));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the signed-out notice when there is no session', (tester) async {
    await tester.pumpWidget(
      _screen(client: _FakeAskAiClient(() => const Stream.empty()), studentId: null),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sign in to ask the study assistant a question.'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('shows the empty state before any question', (tester) async {
    await tester.pumpWidget(_screen(client: _FakeAskAiClient(() => const Stream.empty())));
    await tester.pumpAndSettle();

    expect(find.text('Ask about your study materials'), findsOneWidget);
  });

  testWidgets('streams an answer and renders its citation chip and report action', (tester) async {
    final client = _FakeAskAiClient(
      () => Stream.fromIterable([
        const AskAiSourcesEvent(conversationId: 'conv-1', sources: []),
        const AskAiDeltaEvent('Light '),
        const AskAiDeltaEvent('reactions.'),
        const AskAiDoneEvent(
          messageId: 'msg-1',
          text: 'Light reactions split water. [1]',
          citations: [
            AskAiCitation(
              order: 1,
              chunkId: 'c1',
              materialId: 'm1',
              materialTitle: 'Biology Unit 3',
              pageNumber: 12,
            ),
          ],
        ),
      ]),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    await _ask(tester, 'How do light reactions work?');

    expect(find.text('How do light reactions work?'), findsOneWidget);
    expect(find.text('Light reactions split water. [1]'), findsOneWidget);
    expect(find.byType(AskAiCitationChip), findsOneWidget);
    expect(find.textContaining('Biology Unit 3'), findsOneWidget);
    expect(find.text('Report answer'), findsOneWidget);
  });

  testWidgets('renders a grounding refusal distinctly from an answer', (tester) async {
    final client = _FakeAskAiClient(
      () => Stream.fromIterable([
        const AskAiRefusalEvent([
          AskAiNearestTopic(chunkId: 'c1', materialTitle: 'Algebra Basics'),
        ]),
      ]),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    await _ask(tester, 'Prove Fermat’s last theorem');

    expect(find.text('Not enough to answer that'), findsOneWidget);
    expect(find.textContaining('Algebra Basics'), findsOneWidget);
    expect(find.text('Report answer'), findsNothing);
  });

  testWidgets('a quota problem renders the send-error banner', (tester) async {
    final client = _FakeAskAiClient(
      () => Stream<AskAiEvent>.error(
        const ApiException(status: 429, title: 'quota', code: 'AI_QUOTA_EXCEEDED'),
      ),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    await _ask(tester, 'anything');

    expect(find.text("You've used up this month's AI questions."), findsOneWidget);
  });
}
