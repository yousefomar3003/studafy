// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { isMobileOnly, ROLES } from "./roles";

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

describe("isMobileOnly", () => {
  test.each([
    [["STUDENT"]],
    [["PARENT"]],
    [["INSTRUCTOR"]],
    [["ATTENDANCE_OFFICER"]],
    [["INSTRUCTOR", "PARENT"]],
  ])("%p is mobile-only", (roles) => {
    expect(isMobileOnly(roles)).toBe(true);
  });

  test.each([
    [["ORG_ADMIN"]],
    [["INSTRUCTOR", "ORG_ADMIN"]],
    [["FINANCE"]],
    [["SUPER_ADMIN"]],
    [[]],
  ])("%p keeps web access", (roles) => {
    expect(isMobileOnly(roles)).toBe(false);
  });
});
