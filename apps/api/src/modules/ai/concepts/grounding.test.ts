// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { isConceptGrounded, ungroundedConcepts } from "./grounding";

import type { ConceptInput } from "./merge";
import type { LoadedSummaryChunk } from "../summary/materials";

function chunk(content: string, id = "10000000-0000-4000-8000-000000000001"): LoadedSummaryChunk {
  return { id, chunkIndex: 0, pageNumber: null, sectionTitle: null, content };
}

function concept(over: Partial<ConceptInput> = {}): ConceptInput {
  return {
    name: "Photosynthesis",
    explanation: "Light into chemical energy.",
    source_ids: [1],
    ...over,
  };
}

describe("isConceptGrounded", () => {
  const chunks = [
    chunk("Photosynthesis converts light energy into chemical energy."),
    chunk("Cellular respiration releases energy from glucose."),
  ];

  test("a concept whose name appears in a cited chunk is grounded", () => {
    expect(isConceptGrounded("Photosynthesis", [1], chunks)).toBe(true);
    expect(isConceptGrounded("cellular respiration", [2], chunks)).toBe(true);
  });

  test("a concept is grounded when any cited chunk contains its name", () => {
    // The name is in chunk 1; citing chunk 2 alone must not ground it.
    expect(isConceptGrounded("Photosynthesis", [1, 2], chunks)).toBe(true);
  });

  test("a concept whose name appears in no cited chunk is ungrounded", () => {
    expect(isConceptGrounded("Mitochondria", [1, 2], chunks)).toBe(false);
  });

  test("matching is case- and whitespace-insensitive across chunk boundaries", () => {
    const wrapped = chunk(
      "Photosynthesis\n\nconverts light energy.",
      "10000000-0000-4000-8000-000000000003",
    );
    expect(isConceptGrounded("photosynthesis converts", [1], [wrapped])).toBe(true);
  });

  test("a citation outside the chunk set never grounds a concept", () => {
    expect(isConceptGrounded("Photosynthesis", [9], chunks)).toBe(false);
  });
});

describe("ungroundedConcepts", () => {
  test("returns an empty list when every concept is grounded", () => {
    const concepts = [
      concept({ source_ids: [1] }),
      concept({ name: "Respiration", explanation: "Releases energy.", source_ids: [2] }),
    ];

    expect(
      ungroundedConcepts(concepts, [
        chunk("Photosynthesis converts light energy."),
        chunk("Respiration releases energy from glucose."),
      ]),
    ).toEqual([]);
  });

  test("returns the hallucinated concepts, in model order", () => {
    const concepts = [
      concept({ name: "Photosynthesis", source_ids: [1] }),
      concept({ name: "Mitochondria", source_ids: [2] }),
      concept({ name: "ATP synthase", source_ids: [1] }),
    ];

    expect(
      ungroundedConcepts(concepts, [
        chunk("Photosynthesis converts light energy."),
        chunk("Respiration releases energy from glucose."),
      ]),
    ).toEqual([
      { name: "Mitochondria", source_ids: [2] },
      { name: "ATP synthase", source_ids: [1] },
    ]);
  });
});
