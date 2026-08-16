// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ExamGenerationInvalidError, parseExamGeneration } from "./parser";

const mcqItem = {
  type: "mcq",
  prompt: "What converts light energy into chemical energy?",
  source_id: 1,
  options: [
    { id: "A", text: "Photosynthesis" },
    { id: "B", text: "Respiration" },
  ],
  correct_option_id: "A",
};

describe("parseExamGeneration", () => {
  test("parses a well-formed JSON array", () => {
    const parsed = parseExamGeneration(JSON.stringify([mcqItem]), 2);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: "mcq", source_id: 1 });
  });

  test("strips a ```json fenced block despite being told not to send one", () => {
    const fenced = "```json\n" + JSON.stringify([mcqItem]) + "\n```";
    const parsed = parseExamGeneration(fenced, 2);
    expect(parsed).toHaveLength(1);
  });

  test("strips a plain ``` fenced block", () => {
    const fenced = "```\n" + JSON.stringify([mcqItem]) + "\n```";
    const parsed = parseExamGeneration(fenced, 2);
    expect(parsed).toHaveLength(1);
  });

  test("rejects text that is not valid JSON", () => {
    expect(() => parseExamGeneration("here is your exam: [not json]", 2)).toThrow(
      ExamGenerationInvalidError,
    );
  });

  test("rejects valid JSON that fails the exam item schema", () => {
    expect(() => parseExamGeneration(JSON.stringify([{ type: "mcq" }]), 2)).toThrow(
      ExamGenerationInvalidError,
    );
  });

  test("rejects a source_id outside the given source count", () => {
    const item = { ...mcqItem, source_id: 5 };
    expect(() => parseExamGeneration(JSON.stringify([item]), 2)).toThrow(
      ExamGenerationInvalidError,
    );
  });

  test("accepts a source_id at the upper bound of the source count", () => {
    const item = { ...mcqItem, source_id: 2 };
    const parsed = parseExamGeneration(JSON.stringify([item]), 2);
    expect(parsed[0]!.source_id).toBe(2);
  });
});
