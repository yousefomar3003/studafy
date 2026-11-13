import 'quiz.dart';

/// One pass through a subset of a generated quiz's questions: round 1 covers every question,
/// each retry (`QuizController.retryWrongOnly`) covers only the ones missed on the previous
/// round. See `QuizController` for how a round is played and graded.
class QuizAttempt {
  const QuizAttempt({
    required this.quizId,
    required this.questionIds,
    this.round = 1,
    this.currentIndex = 0,
    this.answers = const {},
    this.results = const {},
  });

  final String quizId;

  /// This round's questions, in play order — the full generated set on round 1, only the
  /// previously-wrong ones on a retry round.
  final List<String> questionIds;

  /// 1 for the original pass, 2+ for a "retry wrong only" round.
  final int round;
  final int currentIndex;

  /// questionId -> submitted answer: the chosen option id for `mcq`, the typed text for
  /// `short_answer`.
  final Map<String, String> answers;

  /// questionId -> revealed outcome, populated as `QuizController.submitAnswer` grades each
  /// question. Only ever holds entries for a question the student has actually answered, until
  /// [isFinished] — a grade call triggered by question 2 must never leak question 5's answer key
  /// before the student gets there.
  final Map<String, QuizQuestionResult> results;

  String get currentQuestionId => questionIds[currentIndex];
  bool get isLastQuestion => currentIndex >= questionIds.length - 1;

  /// Every question in this round has a revealed result — the round is over.
  bool get isFinished => results.length >= questionIds.length;

  int get correctCount => results.values.where((result) => result.correct).length;

  /// Rounded to the nearest whole percent; 0 for a round with no questions.
  int get percentage =>
      questionIds.isEmpty ? 0 : ((correctCount / questionIds.length) * 100).round();

  /// Questions this round got wrong, in play order — what `QuizController.retryWrongOnly` builds
  /// the next round from.
  List<String> get wrongQuestionIds => [
    for (final id in questionIds)
      if (results[id]?.correct == false) id,
  ];

  QuizAttempt copyWith({
    int? currentIndex,
    Map<String, String>? answers,
    Map<String, QuizQuestionResult>? results,
  }) {
    return QuizAttempt(
      quizId: quizId,
      questionIds: questionIds,
      round: round,
      currentIndex: currentIndex ?? this.currentIndex,
      answers: answers ?? this.answers,
      results: results ?? this.results,
    );
  }

  Map<String, Object?> toJson() => {
    'quizId': quizId,
    'questionIds': questionIds,
    'round': round,
    'currentIndex': currentIndex,
    'answers': answers,
    'results': results.map((id, result) => MapEntry(id, result.toJson())),
  };

  factory QuizAttempt.fromJson(Map<String, Object?> json) => QuizAttempt(
    quizId: json['quizId']! as String,
    questionIds: (json['questionIds']! as List<Object?>).cast<String>(),
    round: json['round']! as int,
    currentIndex: json['currentIndex']! as int,
    answers: (json['answers']! as Map<String, Object?>).map((id, answer) => MapEntry(id, answer! as String)),
    results: (json['results']! as Map<String, Object?>).map(
      (id, result) => MapEntry(id, QuizQuestionResult.fromJson(result! as Map<String, Object?>)),
    ),
  );
}

/// The persisted unit for `QuizProgressStore`: a generated quiz plus whichever round of it is (or
/// was last) in play. There is no `GET` endpoint for a generated quiz — the generate response is
/// the only time the client ever sees its questions, options, and citations — so [quiz] is not a
/// cache of a server resource that could be re-fetched; losing this would mean losing the quiz
/// outright, not just unsaved progress.
class QuizSession {
  const QuizSession({required this.quiz, required this.attempt});

  final GeneratedQuiz quiz;
  final QuizAttempt attempt;

  QuizSession copyWith({QuizAttempt? attempt}) =>
      QuizSession(quiz: quiz, attempt: attempt ?? this.attempt);

  Map<String, Object?> toJson() => {'quiz': quiz.toJson(), 'attempt': attempt.toJson()};

  factory QuizSession.fromJson(Map<String, Object?> json) => QuizSession(
    quiz: GeneratedQuiz.fromJson(json['quiz']! as Map<String, Object?>),
    attempt: QuizAttempt.fromJson(json['attempt']! as Map<String, Object?>),
  );
}
