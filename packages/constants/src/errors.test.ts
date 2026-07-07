// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { ERROR_CODES } from "./errors";

describe("ERROR_CODES", () => {
  test("every error code value is unique", () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every key matches its own value (canonical, greppable codes)", () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
    }
  });
});
