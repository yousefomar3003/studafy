/**
 * Deterministic duplicate merging for extracted concepts (ST-169).
 *
 * The model is asked to merge name-equivalent concepts itself, but the acceptance criterion "duplicates
 * merged" cannot rest on a model's word -- the same JSON output that already passed
 * `concepts/parser.ts` is re-checked here, deterministically: two concepts whose names are equal once
 * normalized (trimmed, lowercased, whitespace collapsed) are one concept. The first occurrence keeps
 * its name and explanation (model order is treated as priority), and the sources of every duplicate
 * are unioned -- deduplicated and sorted ascending -- so a concept split across chunks carries every
 * anchor that supports it, which is exactly what "each tied to source anchors" wants the client to
 * render.
 *
 * The result is stable: same input in, same output, every time.
 */

export interface ConceptInput {
  name: string;
  explanation: string;
  /** 1-based source positions as the model cited them; merged by union across duplicates. */
  source_ids: readonly number[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function mergeConcepts(concepts: readonly ConceptInput[]): ConceptInput[] {
  const merged = new Map<string, ConceptInput>();

  for (const concept of concepts) {
    const key = normalizeName(concept.name);
    const existing = merged.get(key);
    if (!existing) {
      // First occurrence wins for the name and explanation; source_ids still deduplicated so a
      // model that repeats an id inside one concept does not double-cite it.
      merged.set(key, { ...concept, source_ids: [...new Set(concept.source_ids)] });
      continue;
    }

    merged.set(key, {
      name: existing.name,
      explanation: existing.explanation,
      source_ids: [...new Set([...existing.source_ids, ...concept.source_ids])].sort(
        (a, b) => a - b,
      ),
    });
  }

  // Insertion order preserves the model's first-seen ordering, so the returned list is stable.
  return [...merged.values()];
}
