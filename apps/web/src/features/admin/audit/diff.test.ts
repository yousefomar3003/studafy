// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildAuditDiff, formatAuditValue } from "./diff";

describe("buildAuditDiff", () => {
  test("omits fields unchanged between before and after", () => {
    const rows = buildAuditDiff(
      { name: "Ada", status: "active" },
      { name: "Ada", status: "suspended" },
    );

    expect(rows).toEqual([
      { key: "status", before: "active", after: "suspended", status: "changed" },
    ]);
  });

  test("marks a field present only in after as added", () => {
    const rows = buildAuditDiff({ name: "Ada" }, { name: "Ada", suspended_reason: "policy" });

    expect(rows).toEqual([
      { key: "suspended_reason", before: undefined, after: "policy", status: "added" },
    ]);
  });

  test("marks a field present only in before as removed", () => {
    const rows = buildAuditDiff({ name: "Ada", suspended_reason: "policy" }, { name: "Ada" });

    expect(rows).toEqual([
      { key: "suspended_reason", before: "policy", after: undefined, status: "removed" },
    ]);
  });

  test("treats a null snapshot as no fields on that side (insert/delete rows)", () => {
    const inserted = buildAuditDiff(null, { name: "Ada" });
    expect(inserted).toEqual([{ key: "name", before: undefined, after: "Ada", status: "added" }]);

    const deleted = buildAuditDiff({ name: "Ada" }, null);
    expect(deleted).toEqual([{ key: "name", before: "Ada", after: undefined, status: "removed" }]);
  });

  test("returns no rows for two null snapshots (read/login/logout/export actions)", () => {
    expect(buildAuditDiff(null, null)).toEqual([]);
  });

  test("compares nested objects and arrays structurally, not by reference", () => {
    const rows = buildAuditDiff({ roles: ["a", "b"] }, { roles: ["a", "b"] });
    expect(rows).toEqual([]);
  });

  test("does not try to unmask a redacted field — it diffs like any other string", () => {
    const rows = buildAuditDiff({ password_hash: "[REDACTED]" }, { password_hash: "[REDACTED]" });
    expect(rows).toEqual([]);
  });
});

describe("formatAuditValue", () => {
  test("renders a missing side as an em dash", () => {
    expect(formatAuditValue(undefined)).toBe("—");
    expect(formatAuditValue(null)).toBe("—");
  });

  test("renders primitives as-is", () => {
    expect(formatAuditValue("[REDACTED]")).toBe("[REDACTED]");
    expect(formatAuditValue(42)).toBe("42");
    expect(formatAuditValue(false)).toBe("false");
  });

  test("pretty-prints objects and arrays as JSON", () => {
    expect(formatAuditValue({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(formatAuditValue([1, 2])).toBe(JSON.stringify([1, 2], null, 2));
  });
});
