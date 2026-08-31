/// Domain models for the two per-material AI study surfaces — the length-preset summary and the
/// key-concepts list — plus the AI quota snapshot the shared meter shows.
///
/// These are what the screens render. `data/ai_study_client.dart` parses the endpoints' wire
/// shapes into them; the widgets never see raw JSON. Kept separate from `ask_ai_conversation.dart`
/// because the two features share no state, only a folder.
library;

import 'package:dio/dio.dart';

import '../../../core/api/api_exception.dart';

/// The length presets `POST /api/ai/students/{id}/summarize` accepts. The source chunks are the
/// same for every preset — only the prompt's length directive and the server cache key differ —
/// so once each preset has been generated once, switching between them is a cache hit.
enum AiSummaryLength {
  brief,
  standard,
  detailed;

  /// The `length` value the endpoint expects.
  String get wire => name;

  /// The preset for a wire value, falling back to [standard] for anything unrecognised.
  static AiSummaryLength fromWire(String value) => switch (value) {
    'brief' => AiSummaryLength.brief,
    'detailed' => AiSummaryLength.detailed,
    _ => AiSummaryLength.standard,
  };
}

/// A machine-readable pointer from a summary or a concept back into the material it was grounded
/// on — one entry of the endpoints' `sources` arrays. A tappable chip opens the material at
/// [pageNumber]. Both endpoints are single-material, so the owning material id is carried by the
/// screen, not the anchor.
class AiSourceAnchor {
  const AiSourceAnchor({
    required this.chunkId,
    required this.chunkIndex,
    required this.order,
    this.pageNumber,
    this.sectionTitle,
  });

  /// `app.material_chunks.id` of the chunk this anchor was rendered from.
  final String chunkId;

  /// The chunk's 0-based ordinal within its material.
  final int chunkIndex;

  /// The anchor's 1-based position in the prompt (the `id` the model was told).
  final int order;

  /// 1-based page (PDF) or slide the chunk sits on, or null for a material with no paginated
  /// structure. The material viewer opens at `pageNumber - 1`.
  final int? pageNumber;

  final String? sectionTitle;
}

/// A generated summary of one material at one [length] preset.
class AiSummary {
  const AiSummary({
    required this.text,
    required this.length,
    required this.cached,
    required this.sources,
  });

  final String text;
  final AiSummaryLength length;

  /// True when the server served this from its Redis cache — a zero-token response.
  final bool cached;

  /// The numbered anchors the summary was grounded on, in prompt order.
  final List<AiSourceAnchor> sources;
}

/// One extracted key concept: its name, a one-line grounded explanation, and every anchor it is
/// tied to.
class AiConcept {
  const AiConcept({required this.name, required this.explanation, required this.sources});

  final String name;
  final String explanation;
  final List<AiSourceAnchor> sources;
}

/// The caller's AI token quota for the current billing period (`GET /api/ai/usage`), shown by the
/// quota meter beneath both screens.
class AiUsage {
  const AiUsage({
    required this.active,
    required this.budget,
    required this.usedTokens,
    required this.heldTokens,
    required this.remaining,
  });

  /// False until something has been reserved or committed this period.
  final bool active;
  final int budget;
  final int usedTokens;

  /// Tokens held by an in-flight request — counted as spent for the meter so it never overshoots.
  final int heldTokens;
  final int remaining;

  /// Committed + held as a fraction of the budget, clamped to `[0, 1]`.
  double get fraction {
    if (budget <= 0) return 0;
    return ((usedTokens + heldTokens) / budget).clamp(0, 1).toDouble();
  }

  /// Whether the meter has anything meaningful to show.
  bool get hasBudget => budget > 0;
}

/// Why an AI study request failed. The screen picks the wording; this only classifies — the same
/// split `AskAiSendError` uses. Covers both the pre-request problem responses and connectivity.
enum AiStudyError {
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

  /// 422 `VALIDATION_FAILED` — the material is still being ingested. "Try later", not "gone".
  notReady,

  /// 404 `RESOURCE_NOT_FOUND` — the material isn't AI-visible or the school can't see it.
  notFound,

  /// 503 `AI_CONCEPTS_GENERATION_FAILED` — the model's output failed validation or grounding.
  generationFailed,

  /// 401 / `AUTHZ_FORBIDDEN` — the session isn't allowed to act on this student's behalf.
  notAllowed,

  /// A connectivity problem — no response reached the client.
  network,

  /// Anything else.
  unknown;

  /// Maps a thrown [DioException] (the client always throws one; its problem+json body is on
  /// [DioExceptionApiError.apiError]) or a bare [ApiException] to a case.
  static AiStudyError classify(Object error) {
    final api = error is ApiException
        ? error
        : error is DioException
        ? error.apiError
        : null;
    if (api != null) {
      return switch (api.code) {
        'AI_QUOTA_EXCEEDED' => AiStudyError.quotaExceeded,
        'AI_SUBSCRIPTION_INACTIVE' => AiStudyError.subscriptionInactive,
        'AI_SCHOOL_INACTIVE' => AiStudyError.schoolInactive,
        'AI_LLM_DISABLED' => AiStudyError.llmDisabled,
        'AI_QUOTA_UNAVAILABLE' => AiStudyError.temporarilyUnavailable,
        'VALIDATION_FAILED' => AiStudyError.notReady,
        'RESOURCE_NOT_FOUND' => AiStudyError.notFound,
        'AI_CONCEPTS_GENERATION_FAILED' => AiStudyError.generationFailed,
        'AUTHZ_FORBIDDEN' => AiStudyError.notAllowed,
        _ => api.status == 401 ? AiStudyError.notAllowed : AiStudyError.unknown,
      };
    }
    if (error is DioException) {
      return switch (error.type) {
        DioExceptionType.connectionTimeout ||
        DioExceptionType.sendTimeout ||
        DioExceptionType.receiveTimeout ||
        DioExceptionType.connectionError => AiStudyError.network,
        _ => AiStudyError.unknown,
      };
    }
    return AiStudyError.unknown;
  }
}
