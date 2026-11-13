import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { createTestSessionStore } from "../../lib/test/session";

import { PortalBackLink, portalParentPath } from "./PortalBackLink";

import type { RouteObject } from "react-router-dom";

/** A trimmed copy of the real portal tree's shape: flat child paths under one `portal` route. */
const ROUTES: RouteObject[] = [
  {
    path: "/",
    children: [
      {
        path: "portal",
        children: [
          { index: true },
          { path: "admin" },
          { path: "admin/students" },
          { path: "admin/students/:studentId" },
          { path: "admin/users" },
          { path: "finance" },
          { path: "finance/adjustments/refunds" },
          { path: "finance/adjustments/refunds/new" },
          { path: "finance/invoices" },
          { path: "finance/invoices/batches/new" },
          { path: "finance/invoices/batches/:batchId" },
          { path: "finance/invoices/:invoiceId" },
          { path: "notifications" },
          { path: "notifications/preferences" },
        ],
      },
    ],
  },
];

afterEach(cleanup);

describe("portalParentPath", () => {
  test.each([
    ["/portal/admin/users", "/portal/admin"],
    ["/portal/admin/students/42", "/portal/admin/students"],
    ["/portal/finance/adjustments/refunds/new", "/portal/finance/adjustments/refunds"],
    // `/portal/finance/adjustments` has no page, so it is skipped.
    ["/portal/finance/adjustments/refunds", "/portal/finance"],
    ["/portal/notifications/preferences/", "/portal/notifications"],
    // `/portal/finance/invoices/batches` only matches the `:invoiceId` page, which is not this
    // path's parent: the static "batches" segment has no page of its own.
    ["/portal/finance/invoices/batches/new", "/portal/finance/invoices"],
    ["/portal/finance/invoices/batches/b-1", "/portal/finance/invoices"],
    ["/portal/finance/invoices/inv-1", "/portal/finance/invoices"],
  ])("%s goes back to %s", (path, parent) => {
    expect(portalParentPath(ROUTES, path)).toBe(parent);
  });

  test("a top-level portal page goes back to the portal itself", () => {
    expect(portalParentPath(ROUTES, "/portal/admin")).toBe("/portal");
  });

  test("nothing above the portal counts", () => {
    expect(portalParentPath(ROUTES, "/portal")).toBeNull();
  });
});

async function renderAt(path: string, roles: string[]) {
  const store = await createTestSessionStore(roles);
  return render(
    <AuthProvider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <PortalBackLink routes={() => ROUTES} />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("PortalBackLink", () => {
  test("links a sub-page back to its parent", async () => {
    await renderAt("/portal/admin/users", ["ORG_ADMIN"]);
    const link = await screen.findByRole("link", { name: "Back" });
    expect(link.getAttribute("href")).toBe("/portal/admin");
  });

  test.each([
    ["the role's own home", "/portal/admin", ["ORG_ADMIN"]],
    ["a sidebar section", "/portal/finance", ["ORG_ADMIN"]],
    ["the portal itself", "/portal", ["INSTRUCTOR"]],
  ])("renders nothing on %s", async (_label, path, roles) => {
    await renderAt(path, roles);
    expect(screen.queryByRole("link", { name: "Back" })).toBeNull();
  });
});
