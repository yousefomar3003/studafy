/**
 * Content class registry tests (SAD §22).
 *
 * The registry is the single source of truth for what may be uploaded and by whom. These tests pin
 * its invariants so a future class cannot ship with an empty allowlist, a non-positive limit, or a
 * missing permission, and so unknown classes keep failing closed.
 */

// Imported before anything else — see the note in src/middleware/authz.test.ts.
import "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { CodedHttpException } from "../../../coded-http-exception";
import { CONTENT_CLASS_KEYS, getContentClass } from "../content-classes";

describe("content classes", () => {
  test("every class has a non-empty allowlist, a positive limit, and a permission", () => {
    for (const key of CONTENT_CLASS_KEYS) {
      const contentClass = getContentClass(key);
      expect(contentClass.allowedContentTypes.size).toBeGreaterThan(0);
      expect(contentClass.maxSizeBytes).toBeGreaterThan(0);
      expect(typeof contentClass.requiredPermission).toBe("string");
    }
  });

  test("keys are unique", () => {
    expect(new Set(CONTENT_CLASS_KEYS).size).toBe(CONTENT_CLASS_KEYS.length);
  });

  test("an unknown class fails closed with 400 VALIDATION_FAILED", () => {
    try {
      getContentClass("no.such.class");
      throw new Error("expected getContentClass to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(400);
      expect((error as CodedHttpException).code).toBe("VALIDATION_FAILED");
    }
  });
});
