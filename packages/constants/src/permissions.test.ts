// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PERMISSIONS, ROLE_PERMISSIONS } from "./permissions";
import { ROLES } from "./roles";

describe("PERMISSIONS", () => {
  test("every permission value is unique", () => {
    const values = Object.values(PERMISSIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every permission maps to at least one role", () => {
    const coveredPermissions = new Set(Object.values(ROLE_PERMISSIONS).flat());

    for (const permission of Object.values(PERMISSIONS)) {
      expect(coveredPermissions.has(permission)).toBe(true);
    }
  });
});

describe("ROLE_PERMISSIONS", () => {
  test("defines an entry for every role", () => {
    for (const role of Object.values(ROLES)) {
      // eslint-disable-next-line security/detect-object-injection -- `role` is drawn only from the fixed ROLES enum, never external input
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  test("SUPER_ADMIN holds every permission", () => {
    const superAdminPermissions = new Set(ROLE_PERMISSIONS[ROLES.SUPER_ADMIN]);

    for (const permission of Object.values(PERMISSIONS)) {
      expect(superAdminPermissions.has(permission)).toBe(true);
    }
  });

  test("no role is assigned an unknown permission", () => {
    const knownPermissions = new Set(Object.values(PERMISSIONS));

    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(knownPermissions.has(permission)).toBe(true);
      }
    }
  });
});
