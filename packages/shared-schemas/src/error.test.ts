import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorCodeSchema, problemDetailsSchema } from "./error";

describe("errorCodeSchema", () => {
  test("accepts every code from @studafy/constants", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(errorCodeSchema.parse(code)).toBe(code);
    }
  });

  test("rejects an unknown code", () => {
    expect(errorCodeSchema.safeParse("NOT_A_REAL_CODE").success).toBe(false);
  });
});

describe("problemDetailsSchema", () => {
  test("defaults type to about:blank", () => {
    const parsed = problemDetailsSchema.parse({
      title: "Not Found",
      status: 404,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
    });
    expect(parsed.type).toBe("about:blank");
  });

  test("round-trips a full problem+json envelope", () => {
    const problem = {
      type: "https://studafy.example/problems/forbidden",
      title: "Forbidden",
      status: 403,
      detail: "You do not have access to this resource.",
      instance: "/courses/123",
      code: ERROR_CODES.AUTHZ_FORBIDDEN,
    };
    const parsed = problemDetailsSchema.parse(problem);
    expect(problemDetailsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(problem);
  });

  test("rejects an envelope whose code is not a constants error code", () => {
    expect(problemDetailsSchema.safeParse({ title: "x", status: 400, code: "BOGUS" }).success).toBe(
      false,
    );
  });

  test("rejects an out-of-range status", () => {
    expect(
      problemDetailsSchema.safeParse({
        title: "x",
        status: 99,
        code: ERROR_CODES.INTERNAL_ERROR,
      }).success,
    ).toBe(false);
  });
});
