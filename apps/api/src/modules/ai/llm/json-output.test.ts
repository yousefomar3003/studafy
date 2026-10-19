// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseFlashcardGeneration } from "../flashcards/parser";

import { unwrapJsonList } from "./json-output";

describe("unwrapJsonList", () => {
  test("reads a one-key object holding an array as that array, whatever the key", () => {
    expect(unwrapJsonList({ cards: [1, 2] })).toEqual([1, 2]);
    expect(unwrapJsonList({ questions: [] })).toEqual([]);
  });

  test("leaves everything else for the schema to judge", () => {
    expect(unwrapJsonList([1])).toEqual([1]);
    expect(unwrapJsonList({ a: [1], b: [2] })).toEqual({ a: [1], b: [2] });
    expect(unwrapJsonList({ cards: "x" })).toEqual({ cards: "x" });
    expect(unwrapJsonList(null)).toBeNull();
    expect(unwrapJsonList("text")).toBe("text");
  });

  test("a JSON-mode deck wrapped in an object parses like a bare array", () => {
    const card = {
      type: "q_a",
      front: "What is ATP?",
      back: "The cell's energy carrier.",
      source_id: 1,
    };
    expect(parseFlashcardGeneration(JSON.stringify({ flashcards: [card] }), 1)).toEqual(
      parseFlashcardGeneration(JSON.stringify([card]), 1),
    );
  });
});
