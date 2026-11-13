import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { permissionsForRoles } from "../../lib/auth";
import { i18next } from "../../lib/i18n/i18next";
import { buildArticles, searchHelpArticles } from "../help/content";

import { searchTranslators } from "./destinations";
import { buildLocalGroups, closestDestinations, helpHref } from "./palette-groups";
import { parseScopedQuery, searchResultsHref } from "./scoped-query";

import type { LocalSearchContext } from "./palette-groups";
import type { Role } from "@studafy/constants";

const ARTICLE = `---
title: "Link a parent to a student"
description: "Connect a parent account to their child."
keywords: ["guardian", "family"]
title_ar: "ربط ولي الأمر بالطالب"
description_ar: "ربط حساب ولي الأمر بابنه."
keywords_ar: ["ولي الأمر", "الأسرة"]
roles: [ORG_ADMIN]
action: link-parent
order: 1
---

# Link a parent to a student

## From the unlinked list

Open Finance and pick the parent with no children yet.

## From the student profile

Use the Guardians tab.
`;

const corpus = buildArticles([{ path: "@docs/help/getting-started/link-parent.md", raw: ARTICLE }]);

function context(roles: readonly Role[], arabic = false): LocalSearchContext {
  return {
    permissions: permissionsForRoles(roles),
    roles,
    t: (key) => i18next.getFixedT(arabic ? "ar" : "en")(key),
    translators: searchTranslators(arabic ? "ar" : "en"),
    arabic,
    searchHelp: (query, options) => searchHelpArticles(query, corpus, options),
  };
}

function firstKey(groupId: string, query: string, roles: readonly Role[]) {
  const group = buildLocalGroups(query, context(roles)).find(
    (candidate) => candidate.id === groupId,
  );
  return group?.items[0]?.key;
}

describe("buildLocalGroups", () => {
  test("groups come in the order Go to, Do, How to, with empty ones dropped", () => {
    const groups = buildLocalGroups("guardian", context([ROLES.ORG_ADMIN]));
    expect(groups.map((group) => group.id)).toEqual(["pages", "actions", "help"]);
    // Only the help fixture's body says "Guardians"; no page or action keyword does.
    expect(
      buildLocalGroups("guardians", context([ROLES.ORG_ADMIN])).map((group) => group.id),
    ).toEqual(["help"]);
  });

  test("keyword hits: academic framework finds Academic setup, guardian finds link parent", () => {
    expect(firstKey("actions", "academic framework", [ROLES.PRINCIPAL])).toBe(
      "actions:set-up-academics",
    );
    expect(firstKey("actions", "guardian", [ROLES.ORG_ADMIN])).toBe("actions:link-parent");
  });

  test("an Arabic keyword, with or without hamza, finds the same entry", () => {
    expect(firstKey("actions", "ولي الأمر", [ROLES.ORG_ADMIN])).toBe("actions:link-parent");
    expect(firstKey("actions", "ولي الامر", [ROLES.ORG_ADMIN])).toBe("actions:link-parent");
  });

  test("only entries the session can open: finance never gets the admin's link-parent", () => {
    const keys = buildLocalGroups("guardian", context([ROLES.FINANCE])).flatMap((group) =>
      group.items.map((item) => item.key),
    );
    expect(keys).not.toContain("actions:link-parent");
  });

  test("a help hit links to its slug, and to the heading the match sits under", () => {
    const help = buildLocalGroups("guardians", context([ROLES.ORG_ADMIN])).find(
      (group) => group.id === "help",
    );
    expect(help?.items[0]).toMatchObject({
      title: "Link a parent to a student",
      subtitle: "From the student profile",
      href: "/help/link-parent#from-the-student-profile",
    });
  });

  test("an Arabic session shows the article's Arabic title", () => {
    const help = buildLocalGroups("ولي الامر", context([ROLES.ORG_ADMIN], true)).find(
      (group) => group.id === "help",
    );
    expect(help?.items[0]?.title).toBe("ربط ولي الأمر بالطالب");
  });

  test("How to stays empty until the help catalogue has loaded", () => {
    const groups = buildLocalGroups("guardian", {
      ...context([ROLES.ORG_ADMIN]),
      searchHelp: undefined,
    });
    expect(groups.some((group) => group.id === "help")).toBe(false);
  });
});

describe("closestDestinations", () => {
  test("offers the nearest registry entries for a misspelling", () => {
    const closest = closestDestinations("timtable", context([ROLES.ORG_ADMIN]));
    expect(closest.map((destination) => destination.id)).toContain("build-timetable");
  });

  test("offers nothing for gibberish", () => {
    expect(closestDestinations("qqzzxx", context([ROLES.ORG_ADMIN]))).toEqual([]);
  });
});

describe("scoped queries", () => {
  test("in:<type> scopes to one record type and leaves the rest as the query", () => {
    expect(parseScopedQuery("in:invoices inv-00")).toEqual({ text: "inv-00", type: "invoices" });
    expect(parseScopedQuery("omar in:student")).toEqual({ text: "omar", type: "students" });
  });

  test("an unknown type is just searched for", () => {
    expect(parseScopedQuery("in:nowhere omar")).toEqual({ text: "in:nowhere omar" });
  });

  test("results page links are shareable URLs", () => {
    expect(searchResultsHref("inv 00", "invoices", 2)).toBe(
      "/portal/search?q=inv+00&type=invoices&page=2",
    );
    expect(helpHref("link-parent", null)).toBe("/help/link-parent");
  });
});
