// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { toDateStr } from "./date-column";

describe("toDateStr", () => {
  test("a date column is its calendar day, never a timestamp", () => {
    // What the driver hands back for date '2010-07-12'.
    expect(toDateStr(new Date("2010-07-12"))).toBe("2010-07-12");
  });

  test("null stays null", () => {
    expect(toDateStr(null)).toBeNull();
  });
});
