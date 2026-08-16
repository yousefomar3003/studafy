// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ConceptGenerationInvalidError, parseConceptGeneration } from "./parser";

describe("parseConceptGeneration", () => {
  const valid = [
    { name: "Photosynthesis", explanation: "Light into chemical energy.", source_ids: [1] },
  ];

  test("accepts a valid concept list", () => {
    expect(parseConceptGeneration(JSON.stringify(valid), 2)).toEqual(valid);
  });

  test("strips a ```json fenced block the model wrapped its answer in", () => {
    const fenced = "```json\n" + JSON.stringify(valid) + "\n```";

    expect(parseConceptGeneration(fenced, 2)).toEqual(valid);
  });

  test("rejects non-JSON output", () => {
    expect(() => parseConceptGeneration("not json at all", 2)).toThrow(
      ConceptGenerationInvalidError,
    );
  });

  test("rejects output that is not an array of concepts", () => {
    expect(() => parseConceptGeneration('{"name":"Photosynthesis"}', 2)).toThrow(
      ConceptGenerationInvalidError,
    );
  });

  test("rejects an empty concept list", () => {
    expect(() => parseConceptGeneration("[]", 2)).toThrow(ConceptGenerationInvalidError);
  });

  test("rejects a concept with an empty name or explanation", () => {
    expect(() =>
      parseConceptGeneration(
        JSON.stringify([{ name: "   ", explanation: "x", source_ids: [1] }]),
        2,
      ),
    ).toThrow(ConceptGenerationInvalidError);

    expect(() =>
      parseConceptGeneration(
        JSON.stringify([{ name: "Photosynthesis", explanation: "  ", source_ids: [1] }]),
        2,
      ),
    ).toThrow(ConceptGenerationInvalidError);
  });

  test("rejects a multi-line explanation, enforcing the one-line contract", () => {
    expect(() =>
      parseConceptGeneration(
        JSON.stringify([
          { name: "Photosynthesis", explanation: "Line one.\nLine two.", source_ids: [1] },
        ]),
        2,
      ),
    ).toThrow(ConceptGenerationInvalidError);
  });

  test("rejects a concept with no sources", () => {
    expect(() =>
      parseConceptGeneration(
        JSON.stringify([{ name: "Photosynthesis", explanation: "x", source_ids: [] }]),
        2,
      ),
    ).toThrow(ConceptGenerationInvalidError);
  });

  test("rejects an unknown top-level key", () => {
    expect(() =>
      parseConceptGeneration(
        JSON.stringify([
          { name: "Photosynthesis", explanation: "x", source_ids: [1], extra: true },
        ]),
        2,
      ),
    ).toThrow(ConceptGenerationInvalidError);
  });

  test("rejects a source_id outside the sources the prompt actually provided", () => {
    const twoSources = JSON.stringify([
      { name: "Photosynthesis", explanation: "Light into chemical energy.", source_ids: [1, 2] },
    ]);

    expect(() => parseConceptGeneration(twoSources, 1)).toThrow(ConceptGenerationInvalidError);
    expect(() => parseConceptGeneration(twoSources, 2)).not.toThrow();
  });

  test("a malformed concept name surfaces the offending path in the error", () => {
    try {
      parseConceptGeneration(JSON.stringify([{ name: "", explanation: "x", source_ids: [1] }]), 2);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConceptGenerationInvalidError);
      expect((error as ConceptGenerationInvalidError).message).toContain("name");
    }
  });
});
