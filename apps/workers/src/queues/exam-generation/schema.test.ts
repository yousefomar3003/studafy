// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { examGenerationSchema } from "./schema";

function validMcq(overrides: Record<string, unknown> = {}) {
  return {
    type: "mcq",
    prompt: "What converts light energy into chemical energy?",
    source_id: 1,
    options: [
      { id: "A", text: "Photosynthesis" },
      { id: "B", text: "Respiration" },
      { id: "C", text: "Fermentation" },
      { id: "D", text: "Digestion" },
    ],
    correct_option_id: "A",
    ...overrides,
  };
}

function validShortAnswer(overrides: Record<string, unknown> = {}) {
  return {
    type: "short_answer",
    prompt: "Name the process that converts light energy into chemical energy.",
    source_id: 1,
    correct_answer: "Photosynthesis",
    ...overrides,
  };
}

describe("exam item schema", () => {
  test("accepts a well-formed mix of mcq and short_answer items", () => {
    const result = examGenerationSchema.safeParse([validMcq(), validShortAnswer()]);
    expect(result.success).toBe(true);
  });

  test("rejects an empty array", () => {
    expect(examGenerationSchema.safeParse([]).success).toBe(false);
  });

  test("rejects an mcq with fewer than 2 options", () => {
    const result = examGenerationSchema.safeParse([
      validMcq({ options: [{ id: "A", text: "Photosynthesis" }] }),
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects an mcq with more than 6 options", () => {
    const options = Array.from({ length: 7 }, (_, i) => ({ id: String(i), text: `Option ${i}` }));
    const result = examGenerationSchema.safeParse([validMcq({ options, correct_option_id: "0" })]);
    expect(result.success).toBe(false);
  });

  test("rejects duplicate option ids", () => {
    const result = examGenerationSchema.safeParse([
      validMcq({
        options: [
          { id: "A", text: "Photosynthesis" },
          { id: "A", text: "Respiration" },
        ],
      }),
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects duplicate option text (case-insensitive)", () => {
    const result = examGenerationSchema.safeParse([
      validMcq({
        options: [
          { id: "A", text: "Photosynthesis" },
          { id: "B", text: "photosynthesis" },
        ],
      }),
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects a correct_option_id that does not name a real option", () => {
    const result = examGenerationSchema.safeParse([validMcq({ correct_option_id: "Z" })]);
    expect(result.success).toBe(false);
  });

  test("rejects an mcq that also carries correct_answer", () => {
    const result = examGenerationSchema.safeParse([
      { ...validMcq(), correct_answer: "Photosynthesis" },
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects an empty short_answer correct_answer", () => {
    const result = examGenerationSchema.safeParse([validShortAnswer({ correct_answer: "   " })]);
    expect(result.success).toBe(false);
  });

  test("rejects a short_answer that also carries options", () => {
    const result = examGenerationSchema.safeParse([
      { ...validShortAnswer(), options: [{ id: "A", text: "x" }] },
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects an unknown item type", () => {
    const result = examGenerationSchema.safeParse([validMcq({ type: "true_false" })]);
    expect(result.success).toBe(false);
  });

  test("rejects a non-positive source_id", () => {
    expect(examGenerationSchema.safeParse([validMcq({ source_id: 0 })]).success).toBe(false);
    expect(examGenerationSchema.safeParse([validShortAnswer({ source_id: -1 })]).success).toBe(
      false,
    );
  });

  test("rejects an empty prompt", () => {
    expect(examGenerationSchema.safeParse([validMcq({ prompt: "   " })]).success).toBe(false);
  });
});
