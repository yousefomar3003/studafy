import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { permissionsForRoles } from "../../lib/auth";

import { SEARCH_TYPES } from "./queries";
import { buildResultGroups, isNavigable } from "./result-groups";

import type { GlobalSearchResult, SearchType } from "./queries";

const ADMIN = permissionsForRoles([ROLES.ORG_ADMIN]);
const PRINCIPAL = permissionsForRoles([ROLES.PRINCIPAL]);
const FINANCE = permissionsForRoles([ROLES.FINANCE]);

type Results = GlobalSearchResult["results"];

function resultWith(
  overrides: Partial<Record<SearchType, unknown[]>>,
  totals: Partial<Record<SearchType, number>> = {},
): GlobalSearchResult {
  const results = Object.fromEntries(SEARCH_TYPES.map((type) => [type, overrides[type] ?? []]));
  const allTotals = Object.fromEntries(
    SEARCH_TYPES.map((type) => [type, totals[type] ?? overrides[type]?.length ?? 0]),
  );
  return {
    query: "ahmad",
    types: [...SEARCH_TYPES],
    results: results as unknown as Results,
    totals: allTotals as GlobalSearchResult["totals"],
  };
}

const STUDENT = {
  id: "s-1",
  first_name: "Ahmad",
  last_name: "Ali",
  preferred_name: null,
  admission_number: "A-100",
  status: "enrolled",
  rank: 0.5,
};

describe("buildResultGroups", () => {
  test("omits types with no hits", () => {
    expect(buildResultGroups(resultWith({}), ADMIN)).toEqual([]);
  });

  test("a student hit links to the admin profile for an org admin", () => {
    expect(buildResultGroups(resultWith({ students: [STUDENT] }), ADMIN)).toEqual([
      {
        type: "students",
        total: 1,
        items: [
          {
            key: "students:s-1",
            title: "Ahmad Ali",
            subtitle: "A-100 · Enrolled",
            href: "/portal/admin/students/s-1",
          },
        ],
      },
    ]);
  });

  test("the same student hit links to the principal page for a principal", () => {
    const [group] = buildResultGroups(resultWith({ students: [STUDENT] }), PRINCIPAL);
    expect(group!.items[0]!.href).toBe("/portal/principal/students/s-1");
  });

  test("prefers a student's preferred name over first/last", () => {
    const [group] = buildResultGroups(
      resultWith({ students: [{ ...STUDENT, preferred_name: "Ace" }] }),
      ADMIN,
    );
    expect(group!.items[0]!.title).toBe("Ace");
  });

  test("a user hit is not linkable for a caller with no page to see people on", () => {
    const user = {
      id: "u-1",
      display_name: "Omar Haddad",
      email: "omar@school.test",
      status: "active",
      rank: 0.4,
    };
    const [forFinance] = buildResultGroups(resultWith({ users: [user] }), FINANCE);
    expect(isNavigable(forFinance!.items[0]!)).toBe(false);
    const [forAdmin] = buildResultGroups(resultWith({ users: [user] }), ADMIN);
    expect(forAdmin!.items[0]!.href).toBe("/portal/admin/users?q=omar%40school.test");
  });

  test("an invoice shows the student's name when RLS lets the caller read it", () => {
    const invoice = {
      id: "i-1",
      erpnext_docname: "INV-0012",
      erpnext_status: "Unpaid",
      total_amount: "1,200.00",
      total_amount_minor: 120000,
      currency: "AED",
      student_id: "s-1",
      student_name: null,
      rank: 0.3,
    };
    const [group] = buildResultGroups(resultWith({ invoices: [invoice] }), FINANCE);
    expect(group!.items[0]).toEqual({
      key: "invoices:i-1",
      title: "INV-0012",
      subtitle: "1,200.00 AED",
      href: "/portal/finance/invoices/i-1",
    });
  });

  test("materials are shown but have no page", () => {
    const material = {
      id: "m-1",
      class_id: "c-1",
      title: "Algebra unit 4",
      description: null,
      ingest_status: "ready",
      rank: 0.2,
    };
    const [group] = buildResultGroups(resultWith({ materials: [material] }), ADMIN);
    expect(group!.items[0]!.href).toBeUndefined();
  });

  test("carries the API total, so the palette can offer See all N", () => {
    const [group] = buildResultGroups(resultWith({ students: [STUDENT] }, { students: 37 }), ADMIN);
    expect(group!.total).toBe(37);
  });

  test("keeps the API's canonical type order", () => {
    const family = {
      id: "f-1",
      display_name: "Haddad family",
      primary_parent_user_id: "u-2",
      primary_parent_name: "Lina Haddad",
      rank: 0.4,
    };
    const notification = {
      id: "n-1",
      title: "Fee reminder",
      notification_type: "invoice_due",
      read_at: null,
      created_at: "2026-10-01T08:00:00.000Z",
      rank: 0.1,
    };
    const groups = buildResultGroups(
      resultWith({ notifications: [notification], families: [family], students: [STUDENT] }),
      ADMIN,
    );
    expect(groups.map((group) => group.type)).toEqual(["students", "families", "notifications"]);
    expect(groups[1]!.items[0]).toMatchObject({
      title: "Haddad family",
      subtitle: "Lina Haddad",
      href: "/portal/finance/families/f-1",
    });
    expect(groups[2]!.items[0]).toMatchObject({
      subtitle: "2026-10-01",
      href: "/portal/notifications",
    });
  });
});
