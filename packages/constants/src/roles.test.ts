// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  ASSIGNABLE_ROLES,
  canChangeRoleOf,
  isMobileOnly,
  isPlatformRole,
  PLATFORM_ROLES,
  ROLES,
} from "./roles";

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

// QA-10 / finding F-01: a school endpoint must never hand out a platform role.
describe("platform roles", () => {
  test("are exactly SUPER_ADMIN and SUPPORT_AGENT", () => {
    expect([...PLATFORM_ROLES].sort()).toEqual([ROLES.SUPER_ADMIN, ROLES.SUPPORT_AGENT]);
    expect(isPlatformRole("SUPER_ADMIN")).toBe(true);
    expect(isPlatformRole("ORG_ADMIN")).toBe(false);
  });

  test("ASSIGNABLE_ROLES is every role except the platform ones, ORG_ADMIN included", () => {
    expect(ASSIGNABLE_ROLES.some(isPlatformRole)).toBe(false);
    expect(ASSIGNABLE_ROLES).toContain(ROLES.ORG_ADMIN);
    expect(ASSIGNABLE_ROLES.length + PLATFORM_ROLES.length).toBe(Object.values(ROLES).length);
  });
});

describe("canChangeRoleOf", () => {
  test("anyone allowed past role:assign may re-role a school user", () => {
    expect(canChangeRoleOf(["ORG_ADMIN"], ["INSTRUCTOR"])).toBe(true);
    expect(canChangeRoleOf(["ORG_ADMIN"], ["ORG_ADMIN"])).toBe(true);
  });

  test("only a SUPER_ADMIN may re-role a platform-role holder", () => {
    expect(canChangeRoleOf(["ORG_ADMIN"], ["SUPER_ADMIN"])).toBe(false);
    expect(canChangeRoleOf(["ORG_ADMIN"], ["SUPPORT_AGENT"])).toBe(false);
    expect(canChangeRoleOf(["SUPER_ADMIN"], ["SUPPORT_AGENT"])).toBe(true);
  });
});
