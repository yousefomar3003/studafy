// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { mergeConcepts } from "./merge";

import type { ConceptInput } from "./merge";

function concept(over: Partial<ConceptInput> = {}): ConceptInput {
  return {
    name: "Photosynthesis",
    explanation: "Light into chemical energy.",
    source_ids: [1],
    ...over,
  };
}

describe("mergeConcepts", () => {
  test("keeps distinct concepts as-is, in first-seen order", () => {
    const concepts = [
      concept({ name: "Photosynthesis", source_ids: [1] }),
      concept({
        name: "Respiration",
        explanation: "Releases energy from glucose.",
        source_ids: [2],
      }),
    ];

    expect(mergeConcepts(concepts)).toEqual(concepts);
  });

  test("merges duplicates whose names differ only by case", () => {
    const merged = mergeConcepts([
      concept({ name: "Photosynthesis", source_ids: [1] }),
      concept({
        name: "photosynthesis",
        explanation: "Light into chemical energy.",
        source_ids: [2],
      }),
    ]);

    expect(merged).toHaveLength(1);
    // First occurrence wins for name and explanation; both sources are retained.
    expect(merged[0]).toEqual({
      name: "Photosynthesis",
      explanation: "Light into chemical energy.",
      source_ids: [1, 2],
    });
  });

  test("merges duplicates whose names differ only by whitespace", () => {
    const merged = mergeConcepts([
      concept({ name: "Cellular respiration", source_ids: [1] }),
      concept({ name: "  Cellular\nrespiration ", source_ids: [2, 3] }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      name: "Cellular respiration",
      explanation: "Light into chemical energy.",
      source_ids: [1, 2, 3],
    });
  });

  test("unions source_ids across three duplicates, deduplicated and sorted", () => {
    const merged = mergeConcepts([
      concept({ source_ids: [3] }),
      concept({ name: "photosynthesis", source_ids: [1, 3] }),
      concept({ name: "PHOTOSYNTHESIS ", source_ids: [2] }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.source_ids).toEqual([1, 2, 3]);
  });

  test("deduplicates repeated ids inside a single concept", () => {
    const merged = mergeConcepts([concept({ source_ids: [2, 2, 1] })]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.source_ids).toEqual([2, 1]);
  });

  test("is deterministic: the same input always produces the same output", () => {
    const input = [
      concept({ name: "Photosynthesis", source_ids: [1, 2] }),
      concept({ name: "photosynthesis", source_ids: [3] }),
      concept({ name: "Respiration", source_ids: [2] }),
    ];

    expect(mergeConcepts(input)).toEqual(mergeConcepts(input));
  });
});
