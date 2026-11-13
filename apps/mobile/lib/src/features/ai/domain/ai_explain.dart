/// Domain model for "Explain it simply": a passage found in the student's materials and its
/// plain-language rewrite at an age-appropriate level.
library;

/// The reading level an explanation is written at. Wire values mirror `AI_EXPLAIN_LEVELS`
/// (`apps/api/src/modules/ai/config.ts`).
enum AiExplainLevel {
  elementary,
  middle,
  high;

  String get wire => name;
}

/// One passage (material chunk) retrieval found for the student's topic — what an explanation is
/// grounded on.
class AiExplainPassage {
  const AiExplainPassage({
    required this.chunkId,
    required this.materialId,
    required this.content,
    this.materialTitle,
    this.pageNumber,
    this.sectionTitle,
  });

  /// `app.material_chunks.id`; what the explain route takes.
  final String chunkId;
  final String materialId;

  /// The passage text as it appears in the material.
  final String content;

  final String? materialTitle;

  /// 1-based page (PDF) or slide, or null for a material with no paginated structure.
  final int? pageNumber;

  final String? sectionTitle;
}
