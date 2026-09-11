// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { validateGuides } from "./validate";

import type { Guide } from "./content/types";
import type { OpenApiPathsDocument } from "./validate";

const fixtureSpec: OpenApiPathsDocument = {
  paths: {
    "/api/widgets": { get: {}, post: {} },
  },
};

const knownCodes = ["WIDGET_NOT_FOUND", "VALIDATION_FAILED"];

function guideWith(sections: Guide["sections"]): Guide {
  return { slug: "fixture", navTitle: "Fixture", title: "Fixture", summary: "", sections };
}

describe("validateGuides", () => {
  test("passes when the documented path/method exists and every code is known", () => {
    const guide = guideWith([
      {
        heading: "Example",
        body: [],
        blocks: [
          {
            language: "http",
            code: "GET /api/widgets",
            api: { method: "GET", path: "/api/widgets", documented: true },
            errorCodes: ["WIDGET_NOT_FOUND"],
          },
        ],
      },
    ]);

    expect(validateGuides([guide], fixtureSpec, knownCodes)).toEqual([]);
  });

  test("fails when a documented path does not exist in the spec", () => {
    const guide = guideWith([
      {
        heading: "Example",
        body: [],
        blocks: [
          {
            language: "http",
            code: "",
            api: { method: "GET", path: "/api/nope", documented: true },
          },
        ],
      },
    ]);

    const issues = validateGuides([guide], fixtureSpec, knownCodes);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("/api/nope");
  });

  test("fails when a documented method does not exist on an existing path", () => {
    const guide = guideWith([
      {
        heading: "Example",
        body: [],
        blocks: [
          {
            language: "http",
            code: "",
            api: { method: "DELETE", path: "/api/widgets", documented: true },
          },
        ],
      },
    ]);

    const issues = validateGuides([guide], fixtureSpec, knownCodes);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("DELETE /api/widgets");
  });

  test("skips the existence check when documented: false", () => {
    const guide = guideWith([
      {
        heading: "Dev-only",
        body: [],
        blocks: [
          {
            language: "http",
            code: "",
            api: { method: "GET", path: "/api/nope", documented: false },
          },
        ],
      },
    ]);

    expect(validateGuides([guide], fixtureSpec, knownCodes)).toEqual([]);
  });

  test("fails when an error code is not a member of ERROR_CODES", () => {
    const guide = guideWith([
      {
        heading: "Example",
        body: [],
        blocks: [{ language: "text", code: "", errorCodes: ["NOT_A_REAL_CODE"] }],
      },
    ]);

    const issues = validateGuides([guide], fixtureSpec, knownCodes);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("NOT_A_REAL_CODE");
  });

  test("reports every issue in one pass, not just the first", () => {
    const guide = guideWith([
      {
        heading: "Example",
        body: [],
        blocks: [
          {
            language: "http",
            code: "",
            api: { method: "GET", path: "/api/nope", documented: true },
          },
          { language: "text", code: "", errorCodes: ["NOT_A_REAL_CODE"] },
        ],
      },
    ]);

    expect(validateGuides([guide], fixtureSpec, knownCodes)).toHaveLength(2);
  });
});
