/// The one thing `ExamProgressStore` persists locally: a pointer to the exam session in play,
/// plus whatever the student has typed/picked so far but not yet submitted.
///
/// Deliberately thin compared to `QuizSession` — an exam has a real `GET` endpoint for every
/// stage of its lifecycle (status, items, timer, report), so there is no need to cache any of
/// that locally the way quiz's one-shot generation response has to be. The only state that
/// exists nowhere on the server until `submit` is called is the in-flight answer draft, so
/// that's the only state worth losing sleep over surviving an app restart.
class ExamDraft {
  const ExamDraft({required this.examSessionId, this.answers = const {}, this.currentIndex = 0});

  final String examSessionId;

  /// itemId -> typed/selected answer, not yet submitted to the server.
  final Map<String, String> answers;

  /// The item the student was last looking at, so a resumed session reopens where they left off
  /// rather than back at item 1.
  final int currentIndex;

  ExamDraft copyWith({Map<String, String>? answers, int? currentIndex}) => ExamDraft(
    examSessionId: examSessionId,
    answers: answers ?? this.answers,
    currentIndex: currentIndex ?? this.currentIndex,
  );

  Map<String, Object?> toJson() => {
    'examSessionId': examSessionId,
    'answers': answers,
    'currentIndex': currentIndex,
  };

  factory ExamDraft.fromJson(Map<String, Object?> json) => ExamDraft(
    examSessionId: json['examSessionId']! as String,
    answers: (json['answers']! as Map<String, Object?>).map(
      (id, answer) => MapEntry(id, answer! as String),
    ),
    currentIndex: json['currentIndex']! as int,
  );
}
