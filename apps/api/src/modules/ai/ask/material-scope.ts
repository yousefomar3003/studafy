import { AI_ASK_MATERIAL_MAX_INPUT_CHARS } from "../config";

import type { GroundedSource } from "./prompt";
import type { LoadedSummaryMaterial } from "../summary/materials";

/**
 * Sources for a question asked about one open material that keyword retrieval could not match.
 *
 * Production retrieval is lexical (ADR-020): a hit needs every content word of the question in one
 * chunk. "Explain this lesson" or "اشرح الدرس" ("explain the lesson") names no word of the lesson,
 * so a material-scoped question used to fall through to a general answer that ignored the material
 * the student had open. The student meant that material, so the answer is grounded on its opening
 * chunks in order -- the summary's contiguous-prefix rule, on a smaller budget sized to the ask
 * route's reservation (`AI_LLM_MAX_RESERVE_TOKENS`).
 */
export function openingSources(
  material: LoadedSummaryMaterial,
  maxChars: number = AI_ASK_MATERIAL_MAX_INPUT_CHARS,
): GroundedSource[] {
  const sources: GroundedSource[] = [];
  let budget = maxChars;
  for (const chunk of material.chunks) {
    if (budget <= 0) break;
    const content = chunk.content.slice(0, budget);
    sources.push({
      order: sources.length + 1,
      chunkId: chunk.id,
      materialId: material.id,
      materialTitle: material.title,
      pageNumber: chunk.pageNumber,
      sectionTitle: chunk.sectionTitle,
      content,
    });
    budget -= content.length;
  }
  return sources;
}
