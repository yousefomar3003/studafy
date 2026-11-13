// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseQuizGeneration, QuizGenerationInvalidError } from "./parser";

const mcqQuestion = {
  type: "mcq",
  prompt: "What converts light energy into chemical energy?",
  source_id: 1,
  options: [
    { id: "A", text: "Photosynthesis" },
    { id: "B", text: "Respiration" },
  ],
  correct_option_id: "A",
};

describe("parseQuizGeneration", () => {
  test("parses a well-formed JSON array", () => {
    const parsed = parseQuizGeneration(JSON.stringify([mcqQuestion]), 2);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: "mcq", source_id: 1 });
  });

  test("strips a ```json fenced block despite being told not to send one", () => {
    const fenced = "```json\n" + JSON.stringify([mcqQuestion]) + "\n```";
    const parsed = parseQuizGeneration(fenced, 2);
    expect(parsed).toHaveLength(1);
  });

  test("strips a plain ``` fenced block", () => {
    const fenced = "```\n" + JSON.stringify([mcqQuestion]) + "\n```";
    const parsed = parseQuizGeneration(fenced, 2);
    expect(parsed).toHaveLength(1);
  });

  test("rejects text that is not valid JSON", () => {
    expect(() => parseQuizGeneration("here is your quiz: [not json]", 2)).toThrow(
      QuizGenerationInvalidError,
    );
  });

  test("rejects valid JSON that fails the quiz schema", () => {
    expect(() => parseQuizGeneration(JSON.stringify([{ type: "mcq" }]), 2)).toThrow(
      QuizGenerationInvalidError,
    );
  });

  test("rejects a source_id outside the given source count", () => {
    const question = { ...mcqQuestion, source_id: 5 };
    expect(() => parseQuizGeneration(JSON.stringify([question]), 2)).toThrow(
      QuizGenerationInvalidError,
    );
  });

  test("accepts a source_id at the upper bound of the source count", () => {
    const question = { ...mcqQuestion, source_id: 2 };
    const parsed = parseQuizGeneration(JSON.stringify([question]), 2);
    expect(parsed[0]!.source_id).toBe(2);
  });
});
