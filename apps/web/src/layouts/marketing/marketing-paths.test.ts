// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { routes } from "../../app/routes";

import { isMarketingPath } from "./marketing-paths";

import type { RouteObject } from "react-router-dom";

/** The children of the route group whose element is `<MarketingLayout />`. */
function marketingChildren(): RouteObject[] {
  const root = routes.find((route) => route.path === "/");
  const group = root?.children?.find(
    (route) =>
      (route.element as { type?: { name?: string } } | undefined)?.type?.name === "MarketingLayout",
  );
  return group?.children ?? [];
}

describe("isMarketingPath", () => {
  test("covers every page rendered inside MarketingLayout", () => {
    const children = marketingChildren();
    expect(children.length).toBeGreaterThan(5);
    for (const child of children) {
      const pathname = child.index ? "/" : `/${child.path}`;
      expect({ pathname, marketing: isMarketingPath(pathname) }).toEqual({
        pathname,
        marketing: true,
      });
    }
  });

  test("the legal documents are marketing pages, the app is not", () => {
    for (const pathname of ["/privacy", "/terms", "/school-agreement", "/legal/delete-account"]) {
      expect(isMarketingPath(pathname)).toBe(true);
    }
    for (const pathname of ["/onboarding", "/account", "/portal/admin"]) {
      expect(isMarketingPath(pathname)).toBe(false);
    }
  });
});
