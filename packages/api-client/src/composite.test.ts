// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { requireCompositeKey } from "./composite";

describe("requireCompositeKey", () => {
  test("returns the key unchanged when both halves are present", () => {
    const key = { id: "row-1", school_id: "school-1" };
    expect(requireCompositeKey(key)).toBe(key);
  });

  test("throws when school_id is missing — the tenant boundary is not optional", () => {
    expect(() => requireCompositeKey({ id: "row-1", school_id: "" })).toThrow(TypeError);
  });

  test("throws when id is missing", () => {
    expect(() => requireCompositeKey({ id: "", school_id: "school-1" })).toThrow(TypeError);
  });
});
