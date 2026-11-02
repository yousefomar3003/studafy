import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_client.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_events.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_history_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ask_ai_conversation.dart';
import 'package:studafy_mobile/src/features/ai/domain/ask_ai_history.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ask_ai_screen.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeAskAiClient implements AskAiClient {
  final conversationIdsSeen = <String?>[];

  @override
  Stream<AskAiEvent> ask({
    required String studentId,
    required String question,
    String? conversationId,
    String? materialId,
    String level = 'high',
  }) {
    conversationIdsSeen.add(conversationId);
    return Stream.fromIterable([
      AskAiSourcesEvent(conversationId: conversationId ?? 'conv-new', sources: const []),
      const AskAiDoneEvent(messageId: 'msg-new', text: 'A fresh answer.', citations: []),
    ]);
  }
}

class _FakeHistoryClient implements AskAiHistoryClient {
  _FakeHistoryClient(this.conversations);

  final List<AskAiConversationSummary> conversations;

  @override
  Future<AskAiConversationPage> list({required String studentId, String? before}) async =>
      AskAiConversationPage(conversations: conversations);

  @override
  Future<AskAiStoredConversation> get({
    required String studentId,
    required String conversationId,
  }) async => AskAiStoredConversation(
    id: conversationId,
    turns: const [
      AskAiTurn(
        question: 'What is osmosis?',
        answer: AskAiAnswerComplete(
          messageId: 'msg-old',
          text: 'Osmosis moves water across a membrane.',
          citations: [],
        ),
      ),
    ],
  );
}

Widget _screen({required AskAiClient client, required AskAiHistoryClient history}) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        askAiClientProvider.overrideWithValue(client),
        askAiHistoryClientProvider.overrideWithValue(history),
        askAiStudentIdProvider.overrideWithValue('student-1'),
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

void main() {
  testWidgets('reopens a chat from history and keeps asking in it', (tester) async {
    final client = _FakeAskAiClient();
    await tester.pumpWidget(
      _screen(
        client: client,
        history: _FakeHistoryClient([
          AskAiConversationSummary(
            id: 'conv-old',
            title: 'What is osmosis?',
            messageCount: 1,
            lastMessageAt: DateTime.now(),
          ),
        ]),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.history_rounded));
    await tester.pumpAndSettle();
    expect(find.text('Chat history'), findsOneWidget);
    expect(find.text('Today'), findsOneWidget);

    await tester.tap(find.text('What is osmosis?'));
    await tester.pumpAndSettle();
    expect(find.text('Osmosis moves water across a membrane.'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'Why does it matter?');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pumpAndSettle();

    expect(client.conversationIdsSeen, ['conv-old']);
  });

  testWidgets('new chat clears the conversation', (tester) async {
    final client = _FakeAskAiClient();
    await tester.pumpWidget(_screen(client: client, history: _FakeHistoryClient(const [])));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'First question');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pumpAndSettle();
    expect(find.text('A fresh answer.'), findsOneWidget);

    await tester.tap(find.byTooltip('New chat'));
    await tester.pumpAndSettle();
    expect(find.text('A fresh answer.'), findsNothing);
    expect(find.text('Ask about your study materials'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'Second question');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pumpAndSettle();
    expect(client.conversationIdsSeen, [null, null]);
  });

  testWidgets('history shows the empty state when there are no chats', (tester) async {
    await tester.pumpWidget(
      _screen(client: _FakeAskAiClient(), history: _FakeHistoryClient(const [])),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.history_rounded));
    await tester.pumpAndSettle();

    expect(find.text('No chats yet'), findsOneWidget);
  });
}
