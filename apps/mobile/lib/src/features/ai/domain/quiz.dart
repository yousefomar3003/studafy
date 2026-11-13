/// Domain model for a generated quiz (ST-230, the mobile counterpart to the API's ST-167): the
/// question set `QuizClient.generateQuiz` returns, and the per-question feedback
/// `QuizClient.gradeQuiz` reveals once an answer is submitted.
///
/// Mirrors `ask_ai_conversation.dart`'s split between the wire shape (`data/quiz_client.dart`
/// parses it, snake_case JSON keys and all) and this on-screen model — a change to the response
/// shape shouldn't ripple into every widget that reads a [QuizQuestion].
library;

/// `mcq` | `short_answer` — see `apps/api/src/modules/ai/quiz/schema.ts`, the schema this mirrors.
enum QuizQuestionType { mcq, shortAnswer }

/// The wire (JSON) spelling of [type] — `"mcq"` | `"short_answer"`. Shared by `QuizClient` (for
/// the outgoing `questionTypes` filter) and `QuizProgressStore` (for local persistence), so the
/// two never drift into different string sets.
String quizQuestionTypeToWire(QuizQuestionType type) => switch (type) {
  QuizQuestionType.mcq => 'mcq',
  QuizQuestionType.shortAnswer => 'short_answer',
};

/// The inverse of [quizQuestionTypeToWire]. Unrecognized input falls back to [QuizQuestionType.mcq]
/// rather than throwing — this only ever reads a value this app already wrote (wire response or
/// local cache), never untrusted input, so a fallback beats a crash on a future server-added type.
QuizQuestionType quizQuestionTypeFromWire(String wire) => switch (wire) {
  'short_answer' => QuizQuestionType.shortAnswer,
  _ => QuizQuestionType.mcq,
};

/// One choice on an [QuizQuestionType.mcq] question.
class QuizOption {
  const QuizOption({required this.id, required this.text});

  final String id;
  final String text;

  Map<String, Object?> toJson() => {'id': id, 'text': text};

  factory QuizOption.fromJson(Map<String, Object?> json) =>
      QuizOption(id: json['id']! as String, text: json['text']! as String);
}

/// A resolved pointer from a question back to the study material it was grounded on. Unlike Ask
/// AI's numbered `[n]` citation list, a quiz question carries exactly one — it was generated from
/// a single source chunk (`quiz/persistence.ts`).
class QuizCitation {
  const QuizCitation({
    required this.chunkId,
    required this.materialId,
    this.materialTitle,
    this.pageNumber,
    this.sectionTitle,
  });

  final String chunkId;
  final String materialId;
  final String? materialTitle;

  /// 1-based page (PDF) or slide (slide deck), or null when the material has no paginated
  /// structure. The material viewer opens at `pageNumber - 1`, same convention as `AskAiCitation`.
  final int? pageNumber;
  final String? sectionTitle;

  Map<String, Object?> toJson() => {
    'chunkId': chunkId,
    'materialId': materialId,
    'materialTitle': materialTitle,
    'pageNumber': pageNumber,
    'sectionTitle': sectionTitle,
  };

  factory QuizCitation.fromJson(Map<String, Object?> json) => QuizCitation(
    chunkId: json['chunkId']! as String,
    materialId: json['materialId']! as String,
    materialTitle: json['materialTitle'] as String?,
    pageNumber: json['pageNumber'] as int?,
    sectionTitle: json['sectionTitle'] as String?,
  );
}

/// One quiz question as generated: prompt, choices (for `mcq`), and citation. Never carries the
/// answer key — that stays server-side until a graded [QuizQuestionResult] reveals it.
class QuizQuestion {
  const QuizQuestion({
    required this.id,
    required this.order,
    required this.type,
    required this.prompt,
    required this.options,
    required this.citation,
  });

  final String id;

  /// 1-based position within the quiz.
  final int order;
  final QuizQuestionType type;
  final String prompt;

  /// Choices for [QuizQuestionType.mcq], in generation order. Null for
  /// [QuizQuestionType.shortAnswer].
  final List<QuizOption>? options;
  final QuizCitation citation;

  Map<String, Object?> toJson() => {
    'id': id,
    'order': order,
    'type': quizQuestionTypeToWire(type),
    'prompt': prompt,
    'options': options?.map((option) => option.toJson()).toList(),
    'citation': citation.toJson(),
  };

  factory QuizQuestion.fromJson(Map<String, Object?> json) {
    final optionsJson = json['options'] as List<Object?>?;
    return QuizQuestion(
      id: json['id']! as String,
      order: json['order']! as int,
      type: quizQuestionTypeFromWire(json['type']! as String),
      prompt: json['prompt']! as String,
      options: optionsJson
          ?.map((option) => QuizOption.fromJson(option! as Map<String, Object?>))
          .toList(),
      citation: QuizCitation.fromJson(json['citation']! as Map<String, Object?>),
    );
  }
}

/// A generated quiz: the question set the setup step produced, before any answers are submitted.
class GeneratedQuiz {
  const GeneratedQuiz({required this.quizId, required this.questions});

  final String quizId;

  /// In generation order (`QuizQuestion.order` ascending).
  final List<QuizQuestion> questions;

  QuizQuestion questionById(String questionId) =>
      questions.firstWhere((question) => question.id == questionId);

  Map<String, Object?> toJson() => {
    'quizId': quizId,
    'questions': questions.map((question) => question.toJson()).toList(),
  };

  factory GeneratedQuiz.fromJson(Map<String, Object?> json) => GeneratedQuiz(
    quizId: json['quizId']! as String,
    questions: (json['questions']! as List<Object?>)
        .map((question) => QuizQuestion.fromJson(question! as Map<String, Object?>))
        .toList(),
  );
}

/// One question's revealed outcome, from `QuizClient.gradeQuiz`. Carries no citation of its own —
/// it's the same question, so callers resolve it from [GeneratedQuiz.questionById] instead of this
/// duplicating it a second time.
class QuizQuestionResult {
  const QuizQuestionResult({
    required this.questionId,
    required this.correct,
    required this.yourAnswer,
    required this.correctAnswer,
  });

  final String questionId;
  final bool correct;

  /// What the student submitted, or null when the question was left unanswered.
  final String? yourAnswer;

  /// The answer key: the correct option id (`mcq`) or the correct text (`short_answer`).
  final String correctAnswer;

  Map<String, Object?> toJson() => {
    'questionId': questionId,
    'correct': correct,
    'yourAnswer': yourAnswer,
    'correctAnswer': correctAnswer,
  };

  factory QuizQuestionResult.fromJson(Map<String, Object?> json) => QuizQuestionResult(
    questionId: json['questionId']! as String,
    correct: json['correct']! as bool,
    yourAnswer: json['yourAnswer'] as String?,
    correctAnswer: json['correctAnswer']! as String,
  );
}
