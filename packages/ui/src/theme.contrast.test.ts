// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { contrastRatio } from "./internal/contrast";
import { textContrastPairs } from "./theme";

describe("WCAG AA text contrast", () => {
  for (const pair of textContrastPairs) {
    test(`${pair.name} meets ${pair.minRatio}:1`, () => {
      expect(contrastRatio(pair.fg, pair.bg)).toBeGreaterThanOrEqual(pair.minRatio);
    });
  }
});
