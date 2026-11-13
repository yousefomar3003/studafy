import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { routes } from "../../app/routes";
import { permissionsForRoles, RequirePermission } from "../../lib/auth";

import { SEARCH_TYPES } from "./queries";
import { RECORD_LINK_CANDIDATES, recordHref } from "./record-links";

import type { SearchHitOf } from "./record-links";
import type { Permission, Role } from "@studafy/constants";
import type { ReactElement } from "react";
import type { RouteObject } from "react-router-dom";

interface PageRoute {
  pattern: RegExp;
  permission: Permission | undefined;
}

function routePermission(route: RouteObject): Permission | undefined {
  const element = route.element as ReactElement<{ permission?: Permission }> | null | undefined;
  return element?.type === RequirePermission ? element.props.permission : undefined;
}

function joinPath(parent: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${parent.replace(/\/$/, "")}/${path}`;
}

/** Every leaf route of the real tree as a matcher (`:param` → one segment, `/*` → the rest). */
function pageRoutes(tree: readonly RouteObject[], parent = ""): PageRoute[] {
  return tree.flatMap((route) => {
    const path = route.index ? parent : joinPath(parent, route.path ?? "");
    if (route.children?.length) return pageRoutes(route.children, path);
    if (!route.element) return [];
    const source = (path || "/").replace(/\/\*$/, "(?:/.*)?").replace(/:[A-Za-z]+/g, "[^/]+");
    return [{ pattern: new RegExp(`^${source}$`), permission: routePermission(route) }];
  });
}

const PAGES = pageRoutes(routes);

function routeFor(href: string): PageRoute | undefined {
  const pathname = href.split(/[?#]/)[0]!;
  // Static routes outrank `:param` and `/*` ones in React Router; prefer the most literal match.
  return PAGES.filter((page) => page.pattern.test(pathname)).sort(
    (a, b) => a.pattern.source.length - b.pattern.source.length,
  )[0];
}

/** A hit of any type: every field reads as a plausible id (an email for `email`). */
const fakeHit = new Proxy(
  {},
  {
    get: (_, key) =>
      key === "email" ? "person@school.test" : "00000000-0000-4000-8000-000000000001",
  },
) as never;

const WEB_ROLES: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ORG_ADMIN,
  ROLES.PRINCIPAL,
  ROLES.FINANCE,
  ROLES.ATTENDANCE_OFFICER,
];

describe("record link candidates", () => {
  test("every candidate's permission is exactly its route's RequirePermission", () => {
    for (const type of SEARCH_TYPES) {
      for (const candidate of RECORD_LINK_CANDIDATES[type]) {
        const href = (candidate.href as (hit: SearchHitOf<typeof type>) => string)(fakeHit);
        const route = routeFor(href);
        expect({ type, href, exists: route !== undefined }).toEqual({ type, href, exists: true });
        expect({ type, href, permission: candidate.permission }).toEqual({
          type,
          href,
          permission: route!.permission,
        });
      }
    }
  });
});

describe("recordHref per role", () => {
  for (const role of WEB_ROLES) {
    test(`${role}: no record link points at a route the role cannot open`, () => {
      const permissions = permissionsForRoles([role]);
      for (const type of SEARCH_TYPES) {
        const href = recordHref(type, fakeHit, permissions);
        if (href === undefined) continue;
        const required = routeFor(href)?.permission;
        expect({
          role,
          type,
          href,
          opens: required === undefined || permissions.has(required),
        }).toEqual({ role, type, href, opens: true });
      }
    });
  }

  test("a student opens the admin profile for an org admin and the principal page for a principal", () => {
    const hit = { id: "s-1" } as SearchHitOf<"students">;
    expect(recordHref("students", hit, permissionsForRoles([ROLES.ORG_ADMIN]))).toBe(
      "/portal/admin/students/s-1",
    );
    expect(recordHref("students", hit, permissionsForRoles([ROLES.PRINCIPAL]))).toBe(
      "/portal/principal/students/s-1",
    );
  });

  test("a user opens the admin user list filtered to them, and is not linkable for finance", () => {
    const hit = {
      id: "u-1",
      email: "omar@school.test",
      display_name: "Omar",
    } as SearchHitOf<"users">;
    expect(recordHref("users", hit, permissionsForRoles([ROLES.ORG_ADMIN]))).toBe(
      "/portal/admin/users?q=omar%40school.test",
    );
    expect(recordHref("users", hit, permissionsForRoles([ROLES.FINANCE]))).toBeUndefined();
  });

  test("finance opens invoices, families and expenses on their own pages", () => {
    const finance = permissionsForRoles([ROLES.FINANCE]);
    expect(recordHref("invoices", { id: "i-1" } as SearchHitOf<"invoices">, finance)).toBe(
      "/portal/finance/invoices/i-1",
    );
    expect(recordHref("families", { id: "f-1" } as SearchHitOf<"families">, finance)).toBe(
      "/portal/finance/families/f-1",
    );
    expect(recordHref("expenses", { id: "e-1" } as SearchHitOf<"expenses">, finance)).toBe(
      "/portal/finance/expenses/e-1",
    );
  });

  test("materials stay read-only, and notifications open the caller's own inbox", () => {
    const admin = permissionsForRoles([ROLES.ORG_ADMIN]);
    expect(recordHref("materials", fakeHit, admin)).toBeUndefined();
    expect(recordHref("notifications", fakeHit, permissionsForRoles([ROLES.FINANCE]))).toBe(
      "/portal/notifications",
    );
  });

  test("calendar events open the admin calendar for an org admin and the principal's otherwise", () => {
    expect(recordHref("events", fakeHit, permissionsForRoles([ROLES.ORG_ADMIN]))).toBe(
      "/portal/admin/calendar",
    );
    expect(recordHref("events", fakeHit, permissionsForRoles([ROLES.PRINCIPAL]))).toBe(
      "/portal/principal/calendar",
    );
  });
});
