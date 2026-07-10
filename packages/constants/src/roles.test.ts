// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ROLES } from "./roles";

describe("ROLES", () => {
  test("every role value is unique", () => {
    const values = Object.values(ROLES);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every key matches its own value (canonical, greppable roles)", () => {
    for (const [key, value] of Object.entries(ROLES)) {
      expect(key).toBe(value);
    }
  });
});
