import 'ai_study.dart';

/// Which kind of AI output a report points at — mirrors `REPORTABLE_CONTENT_TYPES` in
/// `apps/api/src/modules/ai/moderation/reports.ts`.
enum AiReportContentType {
  askAnswer('ask_answer'),
  quiz('quiz'),
  flashcardDeck('flashcard_deck'),
  summary('summary');

  const AiReportContentType(this.wire);

  final String wire;
}

/// Why the student is reporting — mirrors `REPORT_REASON_CATEGORIES`. The server derives the
/// review priority from it: [childSafety] is urgent, [unsafe] and [inappropriate] are high.
enum AiReportReason {
  childSafety('child_safety'),
  unsafe('unsafe'),
  inappropriate('inappropriate'),
  inaccurate('inaccurate'),
  other('other');

  const AiReportReason(this.wire);

  final String wire;
}

/// The AI output being reported. A summary has no id of its own, so it is identified by the
/// summarized material plus the length preset the student was shown.
class AiReportTarget {
  const AiReportTarget.askAnswer(String messageId)
    : this._(AiReportContentType.askAnswer, messageId, null);

  const AiReportTarget.quiz(String quizId) : this._(AiReportContentType.quiz, quizId, null);

  const AiReportTarget.flashcardDeck(String deckId)
    : this._(AiReportContentType.flashcardDeck, deckId, null);

  const AiReportTarget.summary(String materialId, AiSummaryLength length)
    : this._(AiReportContentType.summary, materialId, length);

  const AiReportTarget._(this.contentType, this.contentId, this.summaryLength);

  final AiReportContentType contentType;
  final String contentId;
  final AiSummaryLength? summaryLength;
}

/// The outcome of filing a report.
enum AiReportOutcome {
  /// The report was stored (`201`).
  filed,

  /// This student already reported this item (`409 AI_ANSWER_REPORTED`).
  alreadyFiled,

  /// The report couldn't be filed (network, `404`, anything else).
  failed,
}
