import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { routes } from "../../app/routes";
import { permissionsForRoles, RequirePermission } from "../../lib/auth";
import { i18next } from "../../lib/i18n/i18next";
import { arCatalog, enCatalog } from "../../lib/i18n/locales/catalog";

import {
  destinationById,
  rankDestinations,
  resolveDestination,
  SEARCH_DESTINATIONS,
  searchTranslators,
  splitKeywords,
  suggestedActions,
  visibleDestinations,
} from "./destinations";

import type { SearchDestination } from "./destinations";
import type { Permission } from "@studafy/constants";
import type { ReactElement } from "react";
import type { RouteObject } from "react-router-dom";

/**
 * Authenticated pages deliberately left out of the registry, each with the reason. A page that is
 * neither here nor in `SEARCH_DESTINATIONS` fails the coverage test below.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  "/portal/search": "the search results page itself",
};

/** The ids help articles link to; renaming one breaks their "do it now" links. */
const FIXED_ACTION_IDS = [
  "add-student",
  "import-students",
  "link-parent",
  "invite-staff",
  "set-up-academics",
  "build-timetable",
  "take-attendance",
  "create-invoice-batch",
  "record-payment",
  "issue-refund",
] as const;

interface PageRoute {
  readonly path: string;
  /** The route's `RequirePermission`, undefined when it has none. */
  readonly permission: Permission | undefined;
}

function joinPath(parent: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${parent.replace(/\/$/, "")}/${path}`;
}

function routePermission(route: RouteObject): Permission | undefined {
  const element = route.element as ReactElement<{ permission?: Permission }> | null | undefined;
  return element?.type === RequirePermission ? element.props.permission : undefined;
}

/** Every page (leaf) route of the real route tree, with its full path. */
function pageRoutes(tree: readonly RouteObject[], parent = ""): PageRoute[] {
  return tree.flatMap((route) => {
    const path = route.index ? parent : joinPath(parent, route.path ?? "");
    if (route.children?.length) return pageRoutes(route.children, path);
    return route.element ? [{ path: path || "/", permission: routePermission(route) }] : [];
  });
}

/**
 * The academic setup page mounts its own sub-routes (`<Route path="subjects">`…) behind the one
 * `principal/academic-setup/*` gate; read them from its source so a new tab needs an entry too.
 */
function academicSetupSubPaths(): string[] {
  const file = join(import.meta.dir, "../principal/academic-setup/AcademicSetupPage.tsx");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path inside this repo, resolved against this file
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/<Route\s+(?:index\b|path="([^"]+)")/g)].map(
    (match) => match[1] ?? "",
  );
}

function inScope(path: string): boolean {
  return (
    path === "/help" ||
    path.startsWith("/portal") ||
    path.startsWith("/account") ||
    path.startsWith("/onboarding/setup")
  );
}

/** Non-param authenticated pages (plus the public help home), keyed by pathname. */
const PAGES: ReadonlyMap<string, Permission | undefined> = (() => {
  const pages = new Map<string, Permission | undefined>();
  for (const route of pageRoutes(routes)) {
    if (!inScope(route.path) || route.path.includes(":")) continue;
    if (route.path.endsWith("/*")) {
      const base = route.path.slice(0, -2);
      for (const sub of academicSetupSubPaths()) {
        if (sub === "*" || sub.includes(":")) continue;
        pages.set(sub ? `${base}/${sub}` : base, route.permission);
      }
      continue;
    }
    pages.set(route.path, route.permission);
  }
  return pages;
})();

function pathnameOf(destination: SearchDestination): string {
  return destination.to.split("?")[0]!;
}

function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === "object"
        ? // eslint-disable-next-line security/detect-object-injection -- `part` comes from this registry's own i18n keys, not input
          (node as Record<string, unknown>)[part]
        : undefined,
    catalog,
  );
}

function keysOf(destination: SearchDestination): string[] {
  return [destination.titleKey, destination.keywordsKey, destination.whereKey].filter(
    (key): key is string => key !== undefined,
  );
}

describe("the destinations registry is pinned to the route tree", () => {
  test("the route walk finds the pages it should (sanity check for the tests below)", () => {
    expect(PAGES.get("/portal")).toBeUndefined();
    expect(PAGES.has("/portal")).toBe(true);
    expect(PAGES.get("/portal/platform/schools")).toBe(PERMISSIONS.PLATFORM_READ);
    expect(PAGES.get("/portal/finance/invoices/batches/new")).toBe(PERMISSIONS.BILLING_UPDATE);
    expect(PAGES.get("/portal/principal/academic-setup/scales")).toBe(
      PERMISSIONS.ACADEMIC_CONFIG_READ,
    );
    expect(PAGES.get("/onboarding/setup")).toBe(PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS);
    expect(PAGES.has("/help")).toBe(true);
    expect(PAGES.has("/account/sessions")).toBe(true);
    expect([...PAGES.keys()].some((path) => path.includes(":"))).toBe(false);
  });

  test("every page has an entry, or an EXEMPT reason", () => {
    const covered = new Set(SEARCH_DESTINATIONS.map(pathnameOf));
    const missing = [...PAGES.keys()].filter((path) => !covered.has(path) && !(path in EXEMPT));
    expect(missing).toEqual([]);
  });

  test("every EXEMPT entry says why", () => {
    for (const reason of Object.values(EXEMPT)) expect(reason.trim().length).toBeGreaterThan(0);
  });

  test("every entry leads to a real page, gated exactly as that route is", () => {
    const mismatches = SEARCH_DESTINATIONS.filter((destination) => {
      const path = pathnameOf(destination);
      return !PAGES.has(path) || PAGES.get(path) !== destination.requiredPermission;
    }).map((destination) => ({
      id: destination.id,
      to: destination.to,
      entry: destination.requiredPermission,
      route:
        PAGES.get(pathnameOf(destination)) ??
        (PAGES.has(pathnameOf(destination)) ? "none" : "no such page"),
    }));
    expect(mismatches).toEqual([]);
  });

  test("ids are unique", () => {
    const ids = SEARCH_DESTINATIONS.map((destination) => destination.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the ids help articles link to exist, as actions", () => {
    for (const id of FIXED_ACTION_IDS) expect(destinationById(id)?.kind).toBe("action");
  });

  test("a variant names an earlier canonical entry, which is itself no variant", () => {
    SEARCH_DESTINATIONS.forEach((destination, index) => {
      if (!destination.variantOf) return;
      const canonical = destinationById(destination.variantOf);
      expect(canonical).toBeDefined();
      expect(canonical?.variantOf).toBeUndefined();
      expect(SEARCH_DESTINATIONS.indexOf(canonical!)).toBeLessThan(index);
      expect(canonical?.kind).toBe(destination.kind);
    });
  });

  test("everything but the shared and platform pages is school-scoped", () => {
    const notScoped = SEARCH_DESTINATIONS.filter(
      (destination) =>
        !destination.schoolScoped &&
        destination.requiredPermission !== undefined &&
        destination.requiredPermission !== PERMISSIONS.PLATFORM_READ,
    ).map((destination) => destination.id);
    expect(notScoped).toEqual([]);
  });
});

describe("the destinations' strings", () => {
  test("every key exists, non-empty, in English and Arabic", () => {
    const missing: string[] = [];
    for (const destination of SEARCH_DESTINATIONS) {
      for (const key of keysOf(destination)) {
        for (const [language, catalog] of [
          ["en", enCatalog],
          ["ar", arCatalog],
        ] as const) {
          const value = lookup(catalog, key);
          if (typeof value !== "string" || value.trim() === "") missing.push(`${language}:${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the catalog holds no strings for entries that no longer exist", () => {
    const ids = new Set(SEARCH_DESTINATIONS.map((destination) => destination.id));
    const stale = Object.keys(enCatalog.search.destinations).filter((id) => !ids.has(id));
    expect(stale).toEqual([]);
  });

  test("every entry has 5–15 distinct keywords in each language", () => {
    const outOfRange: string[] = [];
    for (const destination of SEARCH_DESTINATIONS) {
      for (const [language, catalog] of [
        ["en", enCatalog],
        ["ar", arCatalog],
      ] as const) {
        const keywords = splitKeywords(String(lookup(catalog, destination.keywordsKey)));
        const distinct = new Set(keywords.map((keyword) => keyword.toLowerCase()));
        if (keywords.length < 5 || keywords.length > 15 || distinct.size !== keywords.length) {
          outOfRange.push(`${language}:${destination.id} (${keywords.length})`);
        }
      }
    }
    expect(outOfRange).toEqual([]);
  });

  test("keywords split on the Latin and the Arabic comma", () => {
    expect(splitKeywords("bill, fees ،الرسوم، ,  ")).toEqual(["bill", "fees", "الرسوم"]);
  });
});

const ROLE_CASES = [
  ROLES.ORG_ADMIN,
  ROLES.PRINCIPAL,
  ROLES.FINANCE,
  ROLES.ATTENDANCE_OFFICER,
  ROLES.SUPER_ADMIN,
] as const;

function visibleIds(role: string): string[] {
  return visibleDestinations(permissionsForRoles([role])).map((destination) => destination.id);
}

describe("permission filtering", () => {
  for (const role of ROLE_CASES) {
    test(`${role}: no visible entry links to a page the role cannot open`, () => {
      const permissions = permissionsForRoles([role]);
      const visible = visibleDestinations(permissions);
      expect(visible.length).toBeGreaterThan(0);
      const forbidden = visible
        .filter((destination) => {
          const permission = PAGES.get(pathnameOf(destination));
          return permission !== undefined && !permissions.has(permission);
        })
        .map((destination) => destination.id);
      expect(forbidden).toEqual([]);
    });

    test(`${role}: 4–6 suggested actions, each one the role can open`, () => {
      const permissions = permissionsForRoles([role]);
      const visible = new Set(
        visibleDestinations(permissions).map((destination) => destination.id),
      );
      const suggested = suggestedActions(permissions);
      expect(suggested.length).toBeGreaterThanOrEqual(4);
      expect(suggested.length).toBeLessThanOrEqual(6);
      expect(new Set(suggested).size).toBe(suggested.length);
      for (const id of suggested) expect(visible.has(id)).toBe(true);
      expect(destinationById(suggested[0]!)?.kind).toBe("action");
    });
  }

  test("SUPER_ADMIN sees the platform console and nothing school-scoped", () => {
    const visible = visibleDestinations(permissionsForRoles([ROLES.SUPER_ADMIN]));
    const ids = visible.map((destination) => destination.id);
    expect(ids).toContain("platform-overview");
    expect(ids).toContain("review-school-applications");
    expect(ids).toContain("home");
    expect(visible.filter((destination) => destination.schoolScoped)).toEqual([]);
  });

  test("school roles see no platform console", () => {
    for (const role of [
      ROLES.ORG_ADMIN,
      ROLES.PRINCIPAL,
      ROLES.FINANCE,
      ROLES.ATTENDANCE_OFFICER,
    ]) {
      expect(visibleIds(role).filter((id) => id.startsWith("platform-"))).toEqual([]);
    }
  });

  test("each role gets the copy of a shared task in its own portal, once", () => {
    const admin = visibleIds(ROLES.ORG_ADMIN);
    expect(admin).toContain("build-timetable");
    expect(admin).not.toContain("build-timetable-principal");
    expect(admin).toContain("admin-students");
    expect(admin).not.toContain("principal-students");

    const principal = visibleIds(ROLES.PRINCIPAL);
    expect(principal).not.toContain("build-timetable");
    expect(principal).toContain("build-timetable-principal");
    expect(principal).toContain("school-calendar-principal");
    expect(principal).not.toContain("school-calendar");
    expect(principal).toContain("set-up-academics");
    expect(principal).toContain("academic-results");

    const permissions = permissionsForRoles([ROLES.PRINCIPAL]);
    expect(resolveDestination("build-timetable", permissions)?.id).toBe(
      "build-timetable-principal",
    );
    expect(
      resolveDestination("build-timetable-principal", permissionsForRoles([ROLES.ORG_ADMIN]))?.id,
    ).toBe("build-timetable");
    expect(resolveDestination("add-student", permissions)).toBeUndefined();
  });

  test("tasks follow the page's own checks, not just the route's", () => {
    // Taking a register needs attendance:record:create, which the officer holds and the admin not.
    expect(visibleIds(ROLES.ATTENDANCE_OFFICER)).toContain("take-attendance");
    expect(visibleIds(ROLES.ORG_ADMIN)).not.toContain("take-attendance");
    expect(visibleIds(ROLES.ORG_ADMIN)).toContain("attendance-office");
    // Finance opens Unlinked but cannot link; the school admin can.
    expect(visibleIds(ROLES.FINANCE)).toContain("unlinked");
    expect(visibleIds(ROLES.FINANCE)).not.toContain("link-parent");
    expect(visibleIds(ROLES.ORG_ADMIN)).toContain("link-parent");
    // The finance role holds studentRecord:read, but the missing-information lists are leadership's.
    expect(visibleIds(ROLES.FINANCE).filter((id) => id.startsWith("missing-information"))).toEqual(
      [],
    );
    expect(visibleIds(ROLES.FINANCE)).toContain("create-invoice-batch");
    expect(visibleIds(ROLES.PRINCIPAL)).not.toContain("create-invoice-batch");
  });

  test("an empty permission set still reaches the shared pages", () => {
    const ids = visibleDestinations(new Set()).map((destination) => destination.id);
    expect(ids).toEqual([
      "home",
      "notifications",
      "notification-preferences",
      "account",
      "account-sessions",
      "delete-account",
      "help",
    ]);
  });
});

describe("rankDestinations", () => {
  const en = searchTranslators("en");
  const ar = searchTranslators("ar");
  const first = (query: string, translators = en) =>
    rankDestinations(query, SEARCH_DESTINATIONS, translators)[0]?.id;

  test("matches against every shipped language, the active one first", () => {
    expect(en.length).toBe(2);
    expect(ar.length).toBe(2);
  });

  test("a keyword phrase finds its page first", () => {
    expect(first("academic framework")).toBe("set-up-academics");
    expect(first("guardian")).toBe("link-parent");
    expect(first("invoice run")).toBe("create-invoice-batch");
  });

  test("the last word matches as a prefix", () => {
    expect(first("acad")).toBe("set-up-academics");
    expect(first("import stud")).toBe("import-students");
  });

  test("an Arabic keyword finds the same entry, with or without hamza", () => {
    expect(first("ولي الأمر", ar)).toBe("link-parent");
    expect(first("ولي الامر", ar)).toBe("link-parent");
    expect(first("وَلِيّ الأمر", ar)).toBe("link-parent");
  });

  test("an Arabic UI user typing English, and an English one typing Arabic, both find it", () => {
    expect(first("timetable", ar)).toBe("build-timetable");
    expect(first("الجدول الدراسي", en)).toBe("build-timetable");
  });

  test("a title hit outranks a keyword hit, which outranks a breadcrumb hit", () => {
    const ranked = rankDestinations("invoices", SEARCH_DESTINATIONS, en).map((d) => d.id);
    expect(ranked[0]).toBe("invoices");
    // "Finance › Invoices › New batch" is only a breadcrumb (and keyword-prefix) hit.
    expect(ranked.indexOf("create-invoice-batch")).toBeGreaterThan(0);
  });

  test("every word of the query must match somewhere", () => {
    expect(rankDestinations("academic zzzz", SEARCH_DESTINATIONS, en)).toEqual([]);
    expect(rankDestinations("zzzz", SEARCH_DESTINATIONS, en)).toEqual([]);
  });

  test("a blank query matches nothing", () => {
    expect(rankDestinations("  ", SEARCH_DESTINATIONS, en)).toEqual([]);
  });

  test("only ranks the destinations it is given", () => {
    const visible = visibleDestinations(permissionsForRoles([ROLES.PRINCIPAL]));
    const ranked = rankDestinations("timetable", visible, en).map((d) => d.id);
    expect(ranked[0]).toBe("build-timetable-principal");
    expect(ranked).not.toContain("build-timetable");
  });

  test("a translator without the strings (catalog not loaded) matches nothing", () => {
    const keysOnly = (key: string) => key;
    expect(rankDestinations("timetable", SEARCH_DESTINATIONS, keysOnly)).toEqual([]);
  });

  test("searchTranslators reads the shared i18next instance", () => {
    expect(i18next.getFixedT("ar")("search.destinations.home.title")).toBe("الرئيسية");
  });
});
