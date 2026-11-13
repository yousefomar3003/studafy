// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { FEATURE_FLAGS, flagDefault } from "./feature-flags";

import type { FlagName } from "./feature-flags";

const DOTTED_SEGMENT = /^[a-z][a-z0-9]*$/;

describe("FEATURE_FLAGS registry", () => {
  test("is non-empty", () => {
    expect(Object.keys(FEATURE_FLAGS).length).toBeGreaterThan(0);
  });

  test("every name is dotted lowercase, the platform_settings key convention", () => {
    for (const name of Object.keys(FEATURE_FLAGS)) {
      const segments = name.split(".");
      expect(segments.length).toBeGreaterThanOrEqual(2);
      for (const segment of segments) {
        expect(segment).toMatch(DOTTED_SEGMENT);
      }
    }
  });

  test("every definition has a non-empty description and a boolean default", () => {
    for (const [name, definition] of Object.entries(FEATURE_FLAGS)) {
      expect(definition.description.trim().length).toBeGreaterThan(0);
      expect(typeof definition.defaultValue).toBe("boolean");
      expect(flagDefault(name as FlagName)).toBe(definition.defaultValue);
    }
  });

  test("flagDefault returns the registry default for a known flag", () => {
    expect(flagDefault("ai.llm")).toBe(false);
    expect(flagDefault("ai.rerank")).toBe(false);
  });

  test("unknown flag access fails typecheck", () => {
    // The @ts-expect-error is the real assertion: with it removed, `bun run check-types` fails.
    // At runtime the lookup throws rather than silently returning undefined.
    // @ts-expect-error — "ai.bogus" is not in the registry
    expect(() => flagDefault("ai.bogus")).toThrow();
  });
});
