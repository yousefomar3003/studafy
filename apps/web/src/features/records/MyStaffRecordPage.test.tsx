import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { createTestSessionStore } from "../../lib/test/session";

import type { ComponentType, ReactNode } from "react";

/**
 * "My staff record" under /account: a member of staff reads their own non-sensitive fields through
 * `GET /api/me/staff-record`, read-only; the Account page links to it for staff roles only.
 */

const ownRecord = {
  subject_kind: "staff",
  subject_id: "user-1",
  template_version: 1,
  missing_required: 0,
  entries: [
    {
      field: {
        id: "f-qual",
        field_type: "short_text",
        label_en: "Qualification",
        label_ar: "المؤهل",
        help_en: null,
        help_ar: null,
        required: false,
        options: [],
        sort_order: 0,
        visibility: "staff_only",
        sensitivity: "standard",
        has_expiry: false,
      },
      archived: false,
      value: "BEd Mathematics",
      masked: false,
      mask: null,
      answered: true,
      missing: false,
      answered_in_version: 1,
      answered_field: null,
      document: null,
      updated_at: "2026-10-01T00:00:00.000Z",
    },
  ],
};

const getMock = mock((path: string) =>
  Promise.resolve<unknown>({ data: path === "/api/me/staff-record" ? ownRecord : undefined }),
);

mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

async function renderWith(roles: string[], node: ReactNode) {
  const store = await createTestSessionStore(roles);
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ToastProvider>
          <MemoryRouter>
            <main>{node}</main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

const loadPage = async () => (await import("./MyStaffRecordPage")).default as ComponentType;
const loadAccount = async () =>
  (await import("../../routes/account/AccountPage")).default as ComponentType;

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("my staff record", () => {
  test("a member of staff reads their own record through the self route, with no Edit", async () => {
    const Page = await loadPage();
    const { container } = await renderWith(["FINANCE"], <Page />);
    expect(await screen.findByText("BEd Mathematics")).toBeTruthy();
    expect(getMock.mock.calls.map(([path]) => path)).toContain("/api/me/staff-record");
    expect(screen.queryByRole("button", { name: "Edit record" })).toBeNull();
    await expectNoA11yViolations(container);
  });

  test("someone who is not on the staff is told so, and nothing is fetched", async () => {
    const Page = await loadPage();
    await renderWith(["PARENT"], <Page />);
    expect(
      screen.getByText("Only members of the school's staff have a staff record."),
    ).toBeTruthy();
    expect(getMock).not.toHaveBeenCalled();
  });

  test("the Account page links to it for staff only", async () => {
    const Account = await loadAccount();
    await renderWith(["PRINCIPAL"], <Account />);
    expect(screen.getByRole("link", { name: "My staff record" }).getAttribute("href")).toBe(
      "/account/staff-record",
    );
    cleanup();
    await renderWith(["STUDENT"], <Account />);
    expect(screen.queryByRole("link", { name: "My staff record" })).toBeNull();
  });
});
