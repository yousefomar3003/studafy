import 'package:dio/dio.dart';

import '../domain/quiz.dart';

/// Client for the quiz surface — hand-called rather than the generated `StudafyApiClient`, the
/// same call `AskAiClient`'s doc comment explains: both request and response bodies here are
/// anonymous inline schemas in `apps/api/openapi.json` (`quiz-routes.ts` never names them via
/// `.openapi("...")` the way `submissions/schemas.ts` does for e.g. `CreateSubmissionBody`), so
/// the generated class names they'd produce aren't a stable contract to write application code
/// against. The two endpoints' shapes are stable and documented in `quiz-routes.ts` /
/// `quiz/schema.ts`, so hand-parsing them is no less typed in practice — just typed against the
/// source of truth directly instead of through codegen.
///
/// Concrete rather than an interface, matching `AskAiClient`; tests substitute it via
/// `implements QuizClient`, overridden through `quizClientProvider`.
class QuizClient {
  QuizClient(this._dio);

  final Dio _dio;

  /// Generates a quiz from [materialIds] (1-5 materials). [questionCount] defaults to the
  /// server's own default (`AI_QUIZ_DEFAULT_QUESTIONS`) when null; [questionTypes] defaults to
  /// mixing both `mcq` and `short_answer` when null.
  ///
  /// Throws [ApiException]-carrying [DioException] (via `ErrorMappingInterceptor`) for every
  /// failure mode `quiz-routes.ts` documents: the shared AI gate (403/402/429), a material the
  /// school can't see or with no ingested text (404), a material still mid-ingestion (422), the
  /// LLM kill switch or provider failure taxonomy (503), and a model response that failed schema
  /// validation (503 `AI_QUIZ_GENERATION_FAILED`).
  Future<GeneratedQuiz> generateQuiz({
    required String studentId,
    required List<String> materialIds,
    int? questionCount,
    List<QuizQuestionType>? questionTypes,
  }) async {
    final payload = <String, Object?>{'materialIds': materialIds};
    if (questionCount != null) payload['questionCount'] = questionCount;
    if (questionTypes != null) {
      payload['questionTypes'] = questionTypes.map(quizQuestionTypeToWire).toList();
    }

    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/quizzes',
      data: payload,
    );
    return _parseGeneratedQuiz(response.data!);
  }

  /// Grades [answers] (questionId -> submitted answer) against [quizId]'s stored key. Safe to
  /// call repeatedly with a growing answer set — grading is a pure read (no LLM call, no quota
  /// spend, nothing persisted server-side), so re-grading after every newly-answered question is
  /// exactly how `QuizController` gets instant per-question feedback out of a single-shot
  /// endpoint. Omitted questions are scored wrong, not skipped — see `quiz/grading.ts`.
  ///
  /// Returns every question in the quiz, not just the ones named in [answers]; callers decide how
  /// much of that to reveal (`QuizController` only surfaces entries the student actually
  /// submitted, until a round is finished).
  Future<List<QuizQuestionResult>> gradeQuiz({
    required String studentId,
    required String quizId,
    required Map<String, String> answers,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/quizzes/$quizId/grade',
      data: {
        'answers': [
          for (final entry in answers.entries) {'question_id': entry.key, 'answer': entry.value},
        ],
      },
    );
    final results = response.data!['results']! as List<Object?>;
    return results.map((result) => _parseResult(result! as Map<String, Object?>)).toList();
  }

  GeneratedQuiz _parseGeneratedQuiz(Map<String, Object?> json) {
    final questions = (json['questions']! as List<Object?>)
        .map((question) => _parseQuestion(question! as Map<String, Object?>))
        .toList();
    return GeneratedQuiz(quizId: json['quiz_id']! as String, questions: questions);
  }

  QuizQuestion _parseQuestion(Map<String, Object?> json) {
    final optionsJson = json['options'] as List<Object?>?;
    return QuizQuestion(
      id: json['id']! as String,
      order: json['order']! as int,
      type: quizQuestionTypeFromWire(json['type']! as String),
      prompt: json['prompt']! as String,
      options: optionsJson
          ?.map((option) => _parseOption(option! as Map<String, Object?>))
          .toList(),
      citation: _parseCitation(json['citation']! as Map<String, Object?>),
    );
  }

  QuizOption _parseOption(Map<String, Object?> json) =>
      QuizOption(id: json['id']! as String, text: json['text']! as String);

  QuizCitation _parseCitation(Map<String, Object?> json) => QuizCitation(
    chunkId: json['chunk_id']! as String,
    materialId: json['material_id']! as String,
    materialTitle: json['material_title'] as String?,
    pageNumber: json['page_number'] as int?,
    sectionTitle: json['section_title'] as String?,
  );

  QuizQuestionResult _parseResult(Map<String, Object?> json) => QuizQuestionResult(
    questionId: json['question_id']! as String,
    correct: json['correct']! as bool,
    yourAnswer: json['your_answer'] as String?,
    correctAnswer: json['correct_answer']! as String,
  );
}
