import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter, useNavigate } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { createTestSessionStore } from "../../lib/test/session";

import {
  PortalBackLink,
  PortalBackProvider,
  portalParentPath,
  stepTrail,
  trailBackHref,
  usePortalBack,
} from "./PortalBackLink";

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
          { path: "admin/import" },
          { path: "admin/students/imports" },
          { path: "admin/students/imports/:importId" },
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
          { path: "principal" },
          { path: "principal/academic-setup/*" },
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
    // A section that routes its own tabs ("academic-setup/*") is a page at its base, and each of
    // its tabs goes back from that base too.
    ["/portal/principal/academic-setup", "/portal/principal"],
    ["/portal/principal/academic-setup/subjects", "/portal/principal"],
    ["/portal/principal/academic-setup/certificates/c-1", "/portal/principal"],
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

  test("a page can point Back somewhere else, and the shell still draws only one", async () => {
    function PageWithOwnTarget() {
      usePortalBack("/portal/admin/students/42");
      return null;
    }
    const store = await createTestSessionStore(["ORG_ADMIN"]);
    render(
      <AuthProvider store={store}>
        <MemoryRouter initialEntries={["/portal/admin/users"]}>
          <PortalBackProvider>
            <PortalBackLink routes={() => ROUTES} />
            <PageWithOwnTarget />
          </PortalBackProvider>
        </MemoryRouter>
      </AuthProvider>,
    );
    const links = await screen.findAllByRole("link", { name: "Back" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/portal/admin/students/42");
  });

  test.each([
    ["the role's own home", "/portal/admin", ["ORG_ADMIN"]],
    ["another role's dashboard", "/portal/finance", ["ORG_ADMIN"]],
    ["the principal dashboard", "/portal/principal", ["ORG_ADMIN"]],
    ["a sidebar page", "/portal/notifications", ["ORG_ADMIN"]],
    // The same for every role: finance and principal users get no Back on any sidebar page either.
    ["the finance home, for FINANCE", "/portal/finance", ["FINANCE"]],
    ["Approvals, for FINANCE", "/portal/approvals", ["FINANCE"]],
    ["Lists, for FINANCE", "/portal/lists", ["FINANCE"]],
    ["the principal home, for PRINCIPAL", "/portal/principal", ["PRINCIPAL"]],
    ["Approvals, for PRINCIPAL", "/portal/approvals", ["PRINCIPAL"]],
    ["Attendance, for PRINCIPAL", "/portal/attendance", ["PRINCIPAL"]],
    ["Notifications, for PRINCIPAL", "/portal/notifications", ["PRINCIPAL"]],
    ["the portal itself", "/portal", ["INSTRUCTOR"]],
  ])("renders nothing on %s", async (_label, path, roles) => {
    await renderAt(path, roles);
    expect(screen.queryByRole("link", { name: "Back" })).toBeNull();
  });
});

describe("PortalBackLink below a sidebar page", () => {
  test.each([
    ["FINANCE", "/portal/finance/invoices", "/portal/finance"],
    ["PRINCIPAL", "/portal/principal/academic-setup/subjects", "/portal/principal"],
  ])("a %s user gets Back on %s", async (role, path, parent) => {
    await renderAt(path, [role]);
    const link = await screen.findByRole("link", { name: "Back" });
    expect(link.getAttribute("href")).toBe(parent);
  });
});

describe("Back follows the way the user came", () => {
  let go: (to: string) => void = () => undefined;
  function Navigator() {
    const navigate = useNavigate();
    go = (to) => act(() => navigate(to));
    return null;
  }
  async function start(path: string) {
    const store = await createTestSessionStore(["ORG_ADMIN"]);
    render(
      <AuthProvider store={store}>
        <MemoryRouter initialEntries={[path]}>
          <PortalBackProvider>
            <PortalBackLink routes={() => ROUTES} />
            <Navigator />
          </PortalBackProvider>
        </MemoryRouter>
      </AuthProvider>,
    );
  }
  const backHref = () => screen.queryByRole("link", { name: "Back" })?.getAttribute("href");

  test("Import data -> Past imports -> Back returns to Import data, then home", async () => {
    await start("/portal/admin");
    go("/portal/admin/import");
    expect(backHref()).toBe("/portal/admin");
    go("/portal/admin/students/imports");
    // Not the route parent (/portal/admin/students): the page the user came from.
    expect(backHref()).toBe("/portal/admin/import");
    go("/portal/admin/students/imports/imp-1");
    expect(backHref()).toBe("/portal/admin/students/imports");

    fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(backHref()).toBe("/portal/admin/import");
    fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(backHref()).toBe("/portal/admin");
  });

  test("a page opened directly falls back to the page one level up", async () => {
    await start("/portal/admin/students/imports");
    expect(backHref()).toBe("/portal/admin/students");
  });

  test("a sidebar page starts a new trail", async () => {
    await start("/portal/admin/import");
    go("/portal/notifications");
    expect(backHref()).toBeUndefined();
    go("/portal/notifications/preferences");
    expect(backHref()).toBe("/portal/notifications");
  });
});

describe("trail", () => {
  const e = (key: string, href = key) => ({ key, href });

  test("the same page again replaces the last entry, keeping the newest query", () => {
    expect(stepTrail([e("/a"), e("/b", "/b?x=1")], e("/b", "/b?x=2"), false)).toEqual([
      e("/a"),
      e("/b", "/b?x=2"),
    ]);
  });

  test("a submitted form is never the way back", () => {
    expect(trailBackHref([e("/f/refunds"), e("/f/refunds/new"), e("/f/refunds/9")])).toBe(
      undefined,
    );
  });

  test("a page below the current one is never the way back", () => {
    expect(trailBackHref([e("/f/invoices/7"), e("/f/invoices")])).toBeUndefined();
  });
});
