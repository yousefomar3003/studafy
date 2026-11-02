import 'ask_ai_conversation.dart';

/// One earlier Ask AI chat in the history list, titled by its first question.
class AskAiConversationSummary {
  const AskAiConversationSummary({
    required this.id,
    required this.title,
    required this.messageCount,
    required this.lastMessageAt,
  });

  final String id;

  /// The conversation's first question, cut server-side to 200 characters.
  final String title;

  final int messageCount;

  /// When the chat was last added to; the list is ordered by it, newest first.
  final DateTime lastMessageAt;
}

/// One page of [AskAiConversationSummary]s. [nextBefore] is the cursor for the next page, null on
/// the last one.
class AskAiConversationPage {
  const AskAiConversationPage({required this.conversations, this.nextBefore});

  final List<AskAiConversationSummary> conversations;
  final String? nextBefore;
}

/// An earlier chat reopened from history: its id, to keep threading follow-ups onto, and its
/// persisted turns, each a completed answer.
class AskAiStoredConversation {
  const AskAiStoredConversation({required this.id, required this.turns});

  final String id;

  /// Oldest first, every answer an [AskAiAnswerComplete] — only answered turns are persisted.
  final List<AskAiTurn> turns;
}
