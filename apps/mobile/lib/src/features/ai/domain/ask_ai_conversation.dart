/// Domain model for the Ask AI chat: the running conversation, one turn per question, and the
/// lifecycle of each answer as it streams in.
///
/// These types are what the screen renders. They are assembled by [AskAiController] from the raw
/// Server-Sent Events the endpoint emits (`data/ask_ai_events.dart`) — the wire DTOs and the
/// on-screen model are kept separate so a change to the SSE frame shape doesn't ripple into the
/// widgets.
library;

/// A resolved pointer from an answer back into a study material — one `[n]` the model cited,
/// validated server-side against the chunks retrieval actually produced (see
/// `apps/api/src/modules/ai/ask/citations.ts`). Every field but [order]/[chunkId]/[materialId]
/// can be absent for a material with no page structure.
class AskAiCitation {
  const AskAiCitation({
    required this.order,
    required this.chunkId,
    required this.materialId,
    this.materialTitle,
    this.pageNumber,
    this.sectionTitle,
  });

  /// The source's 1-based position, exactly as the model wrote it (`[order]`).
  final int order;

  /// `app.material_chunks.id` — always a chunk that was retrieved for this question.
  final String chunkId;

  /// The material the chunk belongs to; what a citation chip opens.
  final String materialId;

  final String? materialTitle;

  /// 1-based page (PDF) or slide (slide deck) the chunk sits on, or null when the material has
  /// no paginated structure. The material viewer opens at `pageNumber - 1`.
  final int? pageNumber;

  final String? sectionTitle;
}

/// A material retrieval found near the question but not close enough to ground an answer on. The
/// refusal path hands these back so the student gets a concrete next step instead of a dead end.
/// Carries no `materialId` (the endpoint doesn't send one), so it renders as text, not a link.
class AskAiNearestTopic {
  const AskAiNearestTopic({required this.chunkId, this.materialTitle, this.sectionTitle});

  final String chunkId;
  final String? materialTitle;
  final String? sectionTitle;
}

/// The state of the assistant's reply within one [AskAiTurn]. Sealed so the screen's `switch`
/// over it stays exhaustive as states are added.
sealed class AskAiAnswer {
  const AskAiAnswer();
}

/// Tokens are still arriving. [text] is everything received so far — it grows event by event and
/// is empty until the first `delta`.
class AskAiAnswerStreaming extends AskAiAnswer {
  const AskAiAnswerStreaming(this.text);
  final String text;
}

/// The answer finished. [text] is the authoritative full answer from the `done` event (not the
/// concatenated deltas), [citations] the validated `[n]` references, [messageId] the persisted
/// row a report action flags.
class AskAiAnswerComplete extends AskAiAnswer {
  const AskAiAnswerComplete({
    required this.messageId,
    required this.text,
    required this.citations,
  });

  final String messageId;
  final String text;
  final List<AskAiCitation> citations;
}

/// Retrieval couldn't ground the question. No answer was generated; [nearestTopics] is the
/// "try one of these" list.
class AskAiAnswerRefused extends AskAiAnswer {
  const AskAiAnswerRefused(this.nearestTopics);
  final List<AskAiNearestTopic> nearestTopics;
}

/// Output moderation blocked the generated answer. Any partial text already shown is discarded;
/// [guidance] is the localized explanation from the endpoint.
class AskAiAnswerBlocked extends AskAiAnswer {
  const AskAiAnswerBlocked(this.guidance);
  final String guidance;
}

/// A provider or network failure mid-stream. [code] is the endpoint's error code
/// (`AI_LLM_UNAVAILABLE` — transient, retryable; `AI_LLM_REQUEST_REJECTED` — a verdict).
/// Nothing was persisted, so the turn can be re-sent.
class AskAiAnswerFailed extends AskAiAnswer {
  const AskAiAnswerFailed(this.code);
  final String code;

  /// `AI_LLM_REQUEST_REJECTED` means the provider refused the request itself — retrying repeats
  /// the rejection, so the screen hides the retry affordance for it.
  bool get isRetryable => code != 'aiLlmRequestRejected';
}

/// One question-and-answer exchange.
class AskAiTurn {
  const AskAiTurn({required this.question, required this.answer});

  final String question;
  final AskAiAnswer answer;

  AskAiTurn copyWith({AskAiAnswer? answer}) =>
      AskAiTurn(question: question, answer: answer ?? this.answer);
}

/// Why [AskAiController.send] couldn't even open the stream. These are the pre-stream problem
/// responses (quota, entitlement, kill switch, input moderation) — distinct from an
/// [AskAiAnswerFailed], which is a failure *after* the answer path was underway. The screen
/// picks the wording; the controller only classifies, the same split
/// `SubmissionSubmitError` uses.
enum AskAiSendError {
  /// 429 `AI_QUOTA_EXCEEDED` — the student's monthly AI token budget is spent.
  quotaExceeded,

  /// 402 `AI_SUBSCRIPTION_INACTIVE` — the school's AI add-on isn't active.
  subscriptionInactive,

  /// 403 `AI_SCHOOL_INACTIVE` — the school's subscription lapsed.
  schoolInactive,

  /// 503 `AI_LLM_DISABLED` — the AI plane is switched off server-side.
  llmDisabled,

  /// 503 `AI_QUOTA_UNAVAILABLE` — quota couldn't be verified; retrying is the safe move.
  temporarilyUnavailable,

  /// 400 `AI_MODERATION_INPUT_BLOCKED` — the question tripped the content filter. Carries the
  /// server's guidance text in [AskAiConversation.inputBlockedGuidance].
  questionBlocked,

  /// 401 / `AUTHZ_FORBIDDEN` — the session isn't allowed to ask on this student's behalf.
  notAllowed,

  /// A connectivity problem — no response reached the client.
  network,

  /// Anything else.
  unknown,
}

/// Immutable snapshot of the whole chat, owned by [AskAiController].
class AskAiConversation {
  const AskAiConversation({
    this.turns = const [],
    this.isStreaming = false,
    this.conversationId,
    this.sendError,
    this.inputBlockedGuidance,
  });

  /// Oldest first — the screen renders them top to bottom.
  final List<AskAiTurn> turns;

  /// True from the moment [AskAiController.send] is called until the stream settles.
  final bool isStreaming;

  /// The server-assigned id every follow-up question is threaded onto. Null until the first
  /// `sources` or `done` event of the session.
  final String? conversationId;

  /// Set when the most recent send failed before streaming. Cleared on the next send.
  final AskAiSendError? sendError;

  /// The server's localized guidance for [AskAiSendError.questionBlocked]; null otherwise.
  final String? inputBlockedGuidance;

  bool get isEmpty => turns.isEmpty;

  AskAiConversation copyWith({
    List<AskAiTurn>? turns,
    bool? isStreaming,
    String? conversationId,
    AskAiSendError? sendError,
    bool clearSendError = false,
    String? inputBlockedGuidance,
  }) {
    return AskAiConversation(
      turns: turns ?? this.turns,
      isStreaming: isStreaming ?? this.isStreaming,
      conversationId: conversationId ?? this.conversationId,
      sendError: clearSendError ? null : (sendError ?? this.sendError),
      inputBlockedGuidance: clearSendError
          ? null
          : (inputBlockedGuidance ?? this.inputBlockedGuidance),
    );
  }
}
