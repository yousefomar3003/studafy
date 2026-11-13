import 'dart:io';

import 'package:dio/dio.dart';

import '../domain/exam.dart';
import '../domain/exam_session.dart';

/// One [ExamClient] response: the parsed session plus the server's own clock at the moment it
/// answered — what `ExamController` uses to synchronize its countdown against server time
/// instead of trusting the device's own clock (which may be wrong, or deliberately set forward
/// or back). This is display-only synchronization, not the tamper-resistance itself: `submit`
/// enforces the real deadline server-side regardless of what any client believes the remaining
/// time to be.
class ExamClientResult {
  const ExamClientResult({required this.session, required this.serverTime});

  final ExamSession session;
  final DateTime serverTime;
}

/// Client for the exam-mode surface — hand-called rather than the generated `StudafyApiClient`,
/// the same call `QuizClient`'s doc comment makes: `exam-routes.ts` never names its response
/// schema via `.openapi("...")`, so there is no stable generated class to write against; the
/// wire shape is documented and stable in `exam-routes.ts` / `exam/persistence.ts` directly.
///
/// Concrete rather than an interface, matching `QuizClient`; tests substitute it via
/// `implements ExamClient`, overridden through `examClientProvider`.
class ExamClient {
  ExamClient(this._dio);

  final Dio _dio;

  /// Validates [materialIds] and enqueues item-bank generation; the exam starts in `generating`
  /// status — poll [getExam] until it's `ready`. [questionCount] and [durationMinutes] default
  /// to the server's own defaults when null; [questionTypes] defaults to mixing both `mcq` and
  /// `short_answer`.
  ///
  /// Throws [ApiException]-carrying [DioException] for every failure mode `exam-routes.ts`
  /// documents for create: the shared AI gate (403/402/429), a material the school can't see or
  /// with no ingested text (404), a material still mid-ingestion (422), and the generation queue
  /// being unconfigured or an enqueue failure (503 `AI_EXAM_GENERATION_UNAVAILABLE`).
  Future<ExamClientResult> createExam({
    required String studentId,
    required List<String> materialIds,
    int? questionCount,
    List<ExamItemType>? questionTypes,
    int? durationMinutes,
  }) async {
    final payload = <String, Object?>{'materialIds': materialIds};
    if (questionCount != null) payload['questionCount'] = questionCount;
    if (questionTypes != null) {
      payload['questionTypes'] = questionTypes.map(examItemTypeToWire).toList();
    }
    if (durationMinutes != null) payload['durationMinutes'] = durationMinutes;

    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/exams',
      data: payload,
    );
    return _parseResult(response);
  }

  /// Polls a session's status, and reads its items/report once available. Side-effect-free —
  /// safe to call as often as needed, including as the sole means of resuming after an
  /// interruption. Throws for a session that doesn't exist or belongs to a different student
  /// (404 `AI_EXAM_NOT_FOUND`).
  Future<ExamClientResult> getExam({required String studentId, required String examId}) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/ai/students/$studentId/exams/$examId',
    );
    return _parseResult(response);
  }

  /// Begins the server-enforced timer and reveals every item's prompt, options, and citation —
  /// never the answer key. Throws 404 `AI_EXAM_NOT_FOUND` for a missing/foreign session, or 409
  /// `AI_EXAM_INVALID_STATE` when the session isn't `ready` (already started, still generating,
  /// already submitted, or failed).
  Future<ExamClientResult> startExam({required String studentId, required String examId}) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/exams/$examId/start',
    );
    return _parseResult(response);
  }

  /// Submits [answers] (itemId -> answer) for deterministic scoring. Unanswered items are
  /// omitted, not sent as empty strings — the server grades a missing entry wrong the same as an
  /// empty one, so this only sends what the student actually typed or picked. Throws 409
  /// `AI_EXAM_EXPIRED` once the server's clock has passed `expiresAt` — the tamper-resistant
  /// enforcement point — or 409 `AI_EXAM_INVALID_STATE` for a session that isn't `inProgress`.
  Future<ExamClientResult> submitExam({
    required String studentId,
    required String examId,
    required Map<String, String> answers,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/exams/$examId/submit',
      data: {
        'answers': [
          for (final entry in answers.entries) {'item_id': entry.key, 'answer': entry.value},
        ],
      },
    );
    return _parseResult(response);
  }

  ExamClientResult _parseResult(Response<Map<String, Object?>> response) {
    return ExamClientResult(
      session: ExamSession.fromJson(response.data!),
      serverTime: _serverTimeOf(response),
    );
  }

  /// The `Date` response header, which every HTTP response carries — this is the server's own
  /// clock at the moment it answered. Falls back to the device's clock (a no-op skew) if the
  /// header is missing or unparseable, degrading gracefully rather than crashing a request that
  /// otherwise succeeded; the countdown just trusts the device clock a little more in that case.
  DateTime _serverTimeOf(Response<dynamic> response) {
    final header = response.headers.value('date');
    if (header == null) return DateTime.now().toUtc();
    try {
      return HttpDate.parse(header);
    } catch (_) {
      // HttpDate.parse throws HttpException (not FormatException) on a malformed header —
      // caught broadly so a header this codebase never controls can never take down an
      // otherwise-successful response.
      return DateTime.now().toUtc();
    }
  }
}
