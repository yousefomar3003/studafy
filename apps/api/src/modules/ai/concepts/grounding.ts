import type { ConceptInput } from "./merge";
import type { LoadedSummaryChunk } from "../summary/materials";

/**
 * Grounding validator for extracted concepts (ST-169).
 *
 * The acceptance criterion "concepts present in corpus" is enforced here, deterministically, after
 * the model output has been parsed and merged: a concept whose name does not literally appear in
 * any of the chunk texts it cites is a hallucination -- the model invented a topic and pointed at
 * sources that do not support it. The route rejects the whole generation on the first such concept
 * rather than silently dropping it, the same posture `quiz/parser.ts` takes for a bad citation:
 * one ungrounded concept means the output cannot be trusted.
 *
 * This is deliberately a presence check, not a semantic one: `name` is folded (lowercased, runs of
 * whitespace collapsed to a single space) and looked up as a substring of the equally-folded chunk
 * text, so a line break inside a chunk cannot hide a concept the source does state. Whether the
 * explanation is faithful is the model's job; the validator only guarantees the concept the student
 * is handed actually exists in the material it is attributed to.
 */

export interface UngroundedConcept {
  name: string;
  source_ids: readonly number[];
}

/** Fold text for presence matching: lowercase, and collapse every run of whitespace to one space. */
function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/** True when the folded name appears in at least one of the chunk texts the concept cites. */
export function isConceptGrounded(
  name: string,
  sourceIds: readonly number[],
  chunks: readonly LoadedSummaryChunk[],
): boolean {
  const folded = fold(name);
  return sourceIds.some((id) => {
    const chunk = chunks[id - 1];
    return chunk !== undefined && fold(chunk.content).includes(folded);
  });
}

/** The merged concepts that fail grounding, in model order -- empty when every concept is grounded. */
export function ungroundedConcepts(
  concepts: readonly ConceptInput[],
  chunks: readonly LoadedSummaryChunk[],
): UngroundedConcept[] {
  return concepts
    .filter((concept) => !isConceptGrounded(concept.name, concept.source_ids, chunks))
    .map(({ name, source_ids }) => ({ name, source_ids }));
}
