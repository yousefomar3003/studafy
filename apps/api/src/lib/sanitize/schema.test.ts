/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { sanitizedTextSchema } from "./schema";

describe("sanitizedTextSchema", () => {
  test("passes plain text through unchanged", () => {
    const schema = sanitizedTextSchema({ max: 200 });
    expect(schema.parse("Instructors only: staff meeting moved to Friday.")).toBe(
      "Instructors only: staff meeting moved to Friday.",
    );
  });

  test("neutralizes a stored-XSS probe before it reaches the max-length check", () => {
    const schema = sanitizedTextSchema({ max: 200 });
    const out = schema.parse("Reminder <script>alert(1)</script> tomorrow");
    expect(out).not.toContain("<script>");
    expect(out).toContain("Reminder");
    expect(out).toContain("tomorrow");
  });

  test("bounds the SANITIZED length, not the raw input length", () => {
    // "<script>" is 8 raw characters but escapes to "&lt;script&gt;" (14) — 21 raw characters total,
    // under a max of 25, but 27 once escaped. The check must fire on the escaped value, matching
    // what a `CHECK (char_length(...) <= max)` constraint on the same column would see.
    const schema = sanitizedTextSchema({ max: 25 });
    const raw = "<script>alert(1)</scr>"; // 23 raw chars
    expect(raw.length).toBeLessThan(25);
    const result = schema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  test("rejects a value that is empty after trimming, with the custom message", () => {
    const schema = sanitizedTextSchema({ min: 1, minMessage: "Title is required", max: 200 });
    const result = schema.safeParse("   ");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Title is required");
    }
  });

  test("composes with .optional() — undefined short-circuits before sanitizing", () => {
    const schema = sanitizedTextSchema({ max: 50 }).optional();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse("<b>hi</b>")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  test("composes with .nullish() — 'pass null to clear' semantics survive", () => {
    const schema = sanitizedTextSchema({ min: 1, max: 10_000 }).nullish();
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse(undefined)).toBeUndefined();
    const out = schema.parse("<img src=x onerror=alert(1)>Comments for the student.");
    expect(out).not.toContain("onerror");
    expect(out).toContain("Comments for the student.");
  });

  test("composes with .openapi() the same way the field it replaces did", () => {
    const schema = sanitizedTextSchema({ max: 50 })
      .optional()
      .openapi({ description: "Identified strengths." });
    expect(schema.parse("Clear communication with students.")).toBe(
      "Clear communication with students.",
    );
  });
});
