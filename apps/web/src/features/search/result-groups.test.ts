// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildResultGroups, isNavigable } from "./result-groups";

import type { GlobalSearchResult } from "./queries";

function resultWith(overrides: Partial<GlobalSearchResult["results"]>): GlobalSearchResult {
  return {
    query: "ahmad",
    results: {
      students: [],
      users: [],
      invoices: [],
      materials: [],
      ...overrides,
    },
  };
}

describe("buildResultGroups", () => {
  test("omits groups with no hits", () => {
    expect(buildResultGroups(resultWith({}))).toEqual([]);
  });

  test("maps a student hit to its real profile route", () => {
    const groups = buildResultGroups(
      resultWith({
        students: [
          {
            id: "s-1",
            first_name: "Ahmad",
            last_name: "Ali",
            preferred_name: null,
            admission_number: "A-100",
            status: "enrolled",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups).toEqual([
      {
        type: "students",
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

  test("prefers a student's preferred name over first/last", () => {
    const groups = buildResultGroups(
      resultWith({
        students: [
          {
            id: "s-1",
            first_name: "Ahmad",
            last_name: "Ali",
            preferred_name: "Abu Ali",
            admission_number: "A-100",
            status: "enrolled",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups[0]?.items[0]?.title).toBe("Abu Ali");
  });

  test("links a user hit to the users list, pre-filtered by email -- there is no per-user detail route", () => {
    const groups = buildResultGroups(
      resultWith({
        users: [
          {
            id: "u-1",
            display_name: "Jamie Chen",
            email: "jamie@example.edu",
            status: "active",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups[0]).toEqual({
      type: "users",
      items: [
        {
          key: "users:u-1",
          title: "Jamie Chen",
          subtitle: "jamie@example.edu · Active",
          href: "/portal/admin/users?q=jamie%40example.edu",
        },
      ],
    });
  });

  test("falls back to email as the title when a user has no display name", () => {
    const groups = buildResultGroups(
      resultWith({
        users: [
          {
            id: "u-1",
            display_name: null,
            email: "jamie@example.edu",
            status: "invited",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups[0]?.items[0]).toMatchObject({ title: "jamie@example.edu", subtitle: "Invited" });
  });

  test("shows the linked student's name on an invoice hit when present", () => {
    const groups = buildResultGroups(
      resultWith({
        invoices: [
          {
            id: "i-1",
            erpnext_docname: "INV-2026-001",
            erpnext_status: "unpaid",
            total_amount: "1500.00",
            total_amount_minor: 150000,
            currency: "USD",
            student_id: "s-1",
            student_name: "Ahmad Ali",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups[0]).toEqual({
      type: "invoices",
      items: [
        {
          key: "invoices:i-1",
          title: "INV-2026-001",
          subtitle: "Ahmad Ali · 1500.00 USD",
          href: "/portal/finance/invoices/i-1",
        },
      ],
    });
  });

  test("drops the student segment on an invoice hit when the caller can't read that student", () => {
    const groups = buildResultGroups(
      resultWith({
        invoices: [
          {
            id: "i-1",
            erpnext_docname: "INV-2026-001",
            erpnext_status: "unpaid",
            total_amount: "1500.00",
            total_amount_minor: 150000,
            currency: "USD",
            student_id: "s-1",
            student_name: null,
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups[0]?.items[0]?.subtitle).toBe("1500.00 USD");
  });

  test("gives a material hit no href -- there is no materials page in the portal yet", () => {
    const groups = buildResultGroups(
      resultWith({
        materials: [
          {
            id: "m-1",
            class_id: "c-1",
            title: "Algebra unit 4",
            description: null,
            ingest_status: "ready",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups[0]).toEqual({
      type: "materials",
      items: [
        { key: "materials:m-1", title: "Algebra unit 4", subtitle: "Ready", href: undefined },
      ],
    });
    expect(isNavigable(groups[0]!.items[0]!)).toBe(false);
  });

  test("preserves student, users, invoices, materials group order", () => {
    const groups = buildResultGroups(
      resultWith({
        materials: [
          {
            id: "m-1",
            class_id: "c-1",
            title: "Algebra unit 4",
            description: null,
            ingest_status: "ready",
            rank: 0.5,
          },
        ],
        students: [
          {
            id: "s-1",
            first_name: "Ahmad",
            last_name: "Ali",
            preferred_name: null,
            admission_number: "A-100",
            status: "enrolled",
            rank: 0.5,
          },
        ],
      }),
    );

    expect(groups.map((group) => group.type)).toEqual(["students", "materials"]);
  });
});
