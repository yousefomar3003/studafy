// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { firstUngroundedSentence, isExplanationGrounded, wordsOverlap } from "./grounding";

const SOURCE = "The cell converts glucose into energy during respiration.";

describe("isExplanationGrounded", () => {
  test("a faithful paraphrase that reuses the passage's terms is grounded", () => {
    const explanation =
      "During respiration, a cell converts glucose into energy. This is how the body makes energy.";

    expect(isExplanationGrounded(explanation, SOURCE)).toBe(true);
  });

  test("a sentence that drifts out of the passage is not grounded", () => {
    const explanation =
      "The cell converts glucose into energy. The weather on Mars is extremely cold.";

    expect(isExplanationGrounded(explanation, SOURCE)).toBe(false);
    expect(firstUngroundedSentence(explanation, SOURCE)).toBe(
      "The weather on Mars is extremely cold",
    );
  });

  test("a sentence with no significant words is vacuously grounded", () => {
    const explanation = "Yes. The cell converts glucose into energy.";

    expect(isExplanationGrounded(explanation, SOURCE)).toBe(true);
  });

  test("an empty explanation passes the validator because every zero-content sentence is vacuous", () => {
    // The route rejects empty output before it ever reaches the validator (see explain-routes.ts);
    // the validator itself has no content words to check, so it cannot be the one to object.
    expect(isExplanationGrounded("", SOURCE)).toBe(true);
  });

  test("infections are folded by a bounded prefix match", () => {
    expect(wordsOverlap("cell", "cells")).toBe(true);
    expect(wordsOverlap("convert", "converts")).toBe(true);
    expect(wordsOverlap("run", "running")).toBe(true);
  });

  test("an unbounded prefix is deliberately not a match", () => {
    expect(wordsOverlap("biology", "biological")).toBe(false);
  });

  test("stopwords and short words alone cannot ground a sentence", () => {
    // "The and of" carries no content, so it is vacuous; a content word with no source twin is not.
    expect(isExplanationGrounded("The and of.", SOURCE)).toBe(true);
    expect(
      isExplanationGrounded("The and of. The celestial body known as Mars is frozen.", SOURCE),
    ).toBe(false);
  });

  test("the matcher over-matches short shared prefixes by design, not by accident", () => {
    // The documented trade-off (see grounding.ts): art/article share a 3-letter prefix within the
    // 4-char inflection budget, so a stray sentence still passes. The prompt keeps the model on the
    // source, and a rare over-match is safer than a spurious 503 from a strict matcher.
    expect(wordsOverlap("art", "article")).toBe(true);
  });

  test("an empty source leaves nothing to ground against, so everything passes", () => {
    expect(isExplanationGrounded("Anything at all.", "")).toBe(true);
  });
});
