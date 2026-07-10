// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  cursorSchema,
  paginationQuerySchema,
} from "./pagination";

describe("cursorSchema", () => {
  test("accepts a non-empty string", () => {
    expect(cursorSchema.parse("abc123")).toBe("abc123");
  });

  test("rejects an empty string", () => {
    expect(cursorSchema.safeParse("").success).toBe(false);
  });
});

describe("paginationQuerySchema", () => {
  test("defaults limit when omitted", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: PAGINATION_DEFAULT_LIMIT });
  });

  test("coerces a string limit to a number", () => {
    expect(paginationQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  test("caps limit at 100", () => {
    expect(paginationQuerySchema.safeParse({ limit: PAGINATION_MAX_LIMIT }).success).toBe(true);
    expect(paginationQuerySchema.safeParse({ limit: PAGINATION_MAX_LIMIT + 1 }).success).toBe(
      false,
    );
  });

  test("rejects a limit below 1", () => {
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  test("passes an optional cursor through", () => {
    expect(paginationQuerySchema.parse({ cursor: "next" })).toEqual({
      limit: PAGINATION_DEFAULT_LIMIT,
      cursor: "next",
    });
  });
});
