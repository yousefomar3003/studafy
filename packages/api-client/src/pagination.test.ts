// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { assertListParams } from "./pagination";

const SORT_COLUMNS = ["created_at", "updated_at"] as const;

describe("assertListParams", () => {
  test("accepts a valid limit + cursor + indexed sort column", () => {
    expect(() =>
      assertListParams({ limit: 20, cursor: "abc", sort_by: "created_at" }, SORT_COLUMNS),
    ).not.toThrow();
  });

  test("rejects a limit above the hard cap", () => {
    expect(() => assertListParams({ limit: 1000 }, SORT_COLUMNS)).toThrow(RangeError);
  });

  test("rejects a limit below 1", () => {
    expect(() => assertListParams({ limit: 0 }, SORT_COLUMNS)).toThrow(RangeError);
  });

  test("rejects an empty cursor", () => {
    expect(() => assertListParams({ limit: 20, cursor: "" }, SORT_COLUMNS)).toThrow(RangeError);
  });

  test("rejects a sort_by outside the indexed columns (index-bypass guard)", () => {
    expect(() =>
      // @ts-expect-error — a non-indexed column is a compile error too; this asserts the runtime guard.
      assertListParams({ limit: 20, sort_by: "email" }, SORT_COLUMNS),
    ).toThrow(RangeError);
  });
});
