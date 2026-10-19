import type { ConceptInput } from "./merge";
import type { LoadedSummaryChunk } from "../summary/materials";

/**
 * Grounding validator for extracted concepts (ST-169).
 *
 * The acceptance criterion "concepts present in corpus" is enforced here, deterministically, after
 * the model output has been parsed and merged: a concept whose name does not literally appear in
 * any of the chunk texts it cites is never shown. In practice that is mostly a paraphrased name
 * (a small model writing "Carbon dioxide fixation" for "fixes carbon dioxide") rather than an
 * invented topic, so the route drops such concepts and keeps the grounded rest; only a generation
 * where ungrounded concepts outnumber grounded ones is rejected whole as untrustworthy.
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

/**
 * True when the folded name appears in at least one of the chunks the concept cites -- in its text,
 * or in its section heading. The prompt shows each source with its heading (`section="…"`), and a
 * heading is the material's own wording, so a concept named after one ("Limiting Factors") is as
 * grounded as one quoted from the body.
 */
export function isConceptGrounded(
  name: string,
  sourceIds: readonly number[],
  chunks: readonly LoadedSummaryChunk[],
): boolean {
  const folded = fold(name);
  return sourceIds.some((id) => {
    const chunk = chunks[id - 1];
    if (chunk === undefined) return false;
    return (
      fold(chunk.content).includes(folded) ||
      (chunk.sectionTitle !== null && fold(chunk.sectionTitle).includes(folded))
    );
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
