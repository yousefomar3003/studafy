// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PERMISSIONS, ROLE_PERMISSIONS } from "./permissions";
import { ROLES, SCHOOL_STAFF_ROLES } from "./roles";

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

  function rolesHolding(permission: string): string[] {
    return Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => (permissions as readonly string[]).includes(permission))
      .map(([role]) => role)
      .sort();
  }

  // Teachers read attendance reports for their own classes (row scope narrows them); exporting stays
  // with school leadership and the attendance office.
  test("attendance report read and export are held by the expected roles", () => {
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_REPORT_READ)).toEqual(
      [
        ROLES.ATTENDANCE_OFFICER,
        ROLES.INSTRUCTOR,
        ROLES.ORG_ADMIN,
        ROLES.PRINCIPAL,
        ROLES.SUPER_ADMIN,
      ].sort(),
    );
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_REPORT_EXPORT)).toEqual(
      [ROLES.ATTENDANCE_OFFICER, ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  // Registers are taken by the attendance office and by teachers (row scope keeps a teacher to their
  // own classes); corrections stay with the office and the principal. SUPER_ADMIN holds every
  // permission by design.
  test("the attendance officer and teachers take registers", () => {
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_RECORD_CREATE)).toEqual(
      [ROLES.ATTENDANCE_OFFICER, ROLES.INSTRUCTOR, ROLES.SUPER_ADMIN].sort(),
    );
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_RECORD_CORRECT)).toEqual(
      [ROLES.ATTENDANCE_OFFICER, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  test("admin, principal, teacher and attendance officer get the attendance dashboard", () => {
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW)).toEqual(
      [
        ROLES.ATTENDANCE_OFFICER,
        ROLES.INSTRUCTOR,
        ROLES.ORG_ADMIN,
        ROLES.PRINCIPAL,
        ROLES.SUPER_ADMIN,
      ].sort(),
    );
  });

  // School-defined records (docs/modules/student-records.md): leadership builds templates, fills
  // records and reveals sensitive values; finance, teachers and parents only read, narrowed by
  // field visibility and row scope. Nobody else reads them, and no reader holds update.
  test("records: leadership manages and reveals; finance, teachers and parents read", () => {
    const leadership = [ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort();
    expect(rolesHolding(PERMISSIONS.RECORD_TEMPLATE_MANAGE)).toEqual(leadership);
    expect(rolesHolding(PERMISSIONS.STUDENT_RECORD_UPDATE)).toEqual(leadership);
    expect(rolesHolding(PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE)).toEqual(leadership);
    expect(rolesHolding(PERMISSIONS.STUDENT_RECORD_READ)).toEqual(
      [
        ROLES.FINANCE,
        ROLES.INSTRUCTOR,
        ROLES.ORG_ADMIN,
        ROLES.PARENT,
        ROLES.PRINCIPAL,
        ROLES.SUPER_ADMIN,
      ].sort(),
    );
  });

  // Staff and class records: a colleague's file is the employer's (ORG_ADMIN), the principal reads
  // its non-sensitive fields only, and a class's record is read by leadership and its teachers.
  test("staff records: ORG_ADMIN edits and reveals; the principal only reads", () => {
    const admins = [ROLES.ORG_ADMIN, ROLES.SUPER_ADMIN].sort();
    expect(rolesHolding(PERMISSIONS.STAFF_RECORD_UPDATE)).toEqual(admins);
    expect(rolesHolding(PERMISSIONS.STAFF_RECORD_READ_SENSITIVE)).toEqual(admins);
    expect(rolesHolding(PERMISSIONS.STAFF_RECORD_READ)).toEqual(
      [ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  test("class records: leadership and teachers read; editing comes with timetable:manage", () => {
    expect(rolesHolding(PERMISSIONS.CLASS_RECORD_READ)).toEqual(
      [ROLES.INSTRUCTOR, ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
    expect(rolesHolding(PERMISSIONS.TIMETABLE_MANAGE)).toEqual(
      [ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  test("class AI materials setting: the class's teachers and school leadership (000196)", () => {
    expect(rolesHolding(PERMISSIONS.MATERIAL_MANAGE_AI)).toEqual(
      [ROLES.INSTRUCTOR, ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  // Custom lists: leadership shapes them; every school staff role may work in one, narrowed by the
  // list's audience; families never hold any of it.
  describe("custom lists", () => {
    test("leadership manages lists and reveals sensitive cells", () => {
      const leadership = [ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort();
      expect(rolesHolding(PERMISSIONS.CUSTOM_LIST_MANAGE)).toEqual(leadership);
      expect(rolesHolding(PERMISSIONS.CUSTOM_LIST_READ_SENSITIVE)).toEqual(leadership);
    });

    test("every school staff role may use lists; parents and students never", () => {
      expect(rolesHolding(PERMISSIONS.CUSTOM_LIST_USE)).toEqual(
        [...SCHOOL_STAFF_ROLES, ROLES.SUPER_ADMIN].sort(),
      );
      for (const role of [ROLES.PARENT, ROLES.STUDENT, ROLES.GUEST]) {
        for (const permission of [
          PERMISSIONS.CUSTOM_LIST_MANAGE,
          PERMISSIONS.CUSTOM_LIST_USE,
          PERMISSIONS.CUSTOM_LIST_READ_SENSITIVE,
        ]) {
          expect(ROLE_PERMISSIONS[role]).not.toContain(permission);
        }
      }
    });
  });
});

describe("SCHOOL_STAFF_ROLES", () => {
  test("is the school's own staff, never a platform role or a family member", () => {
    expect([...SCHOOL_STAFF_ROLES].sort()).toEqual(
      [
        ROLES.ATTENDANCE_OFFICER,
        ROLES.FINANCE,
        ROLES.INSTRUCTOR,
        ROLES.ORG_ADMIN,
        ROLES.PRINCIPAL,
      ].sort(),
    );
  });
});
