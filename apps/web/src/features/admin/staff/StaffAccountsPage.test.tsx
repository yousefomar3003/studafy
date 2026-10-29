import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * Principal & finance accounts: the admin invites by email and role (Principal or Finance), the
 * list merges both roles' invitations, and pending/expired invitations can be resent.
 */

const PENDING_ID = "11111111-1111-4111-8111-111111111111";
const ACCEPTED_ID = "22222222-2222-4222-8222-222222222222";

function invitation(id: string, email: string, role: string, status: string, createdAt: string) {
  return {
    id,
    email,
    role,
    status,
    expires_at: "2026-12-01T00:00:00.000Z",
    revoked_at: null,
    consumed_at: status === "consumed" ? createdAt : null,
    invited_by_user_id: null,
    created_at: createdAt,
  };
}

const getMock = mock((path: string, init: { params: { query: { role: string } } }) => {
  if (path !== "/api/invitations") throw new Error(`Unhandled GET ${path}`);
  const rows =
    init.params.query.role === "PRINCIPAL"
      ? [
          invitation(
            ACCEPTED_ID,
            "head@alpha.test",
            "PRINCIPAL",
            "consumed",
            "2026-09-01T00:00:00.000Z",
          ),
        ]
      : [
          invitation(
            PENDING_ID,
            "money@alpha.test",
            "FINANCE",
            "pending",
            "2026-10-01T00:00:00.000Z",
          ),
        ];
  return Promise.resolve({ data: { invitations: rows, next_cursor: null } });
});
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/invitations") return Promise.resolve({ data: { token: "t" } });
  if (path === "/api/invitations/{id}/regenerate") return Promise.resolve({ data: { token: "t" } });
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./StaffAccountsPage")).default;

/** Renders the router's current `search`, so a test can see a query parameter being dropped. */
function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

async function renderPage(initialEntry = "/portal/accounts") {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Page />
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("StaffAccountsPage", () => {
  test("lists principal and finance invitations newest first", async () => {
    await renderPage();
    const table = await screen.findByRole("table", { name: "Principal and finance invitations" });
    await within(table).findByText("money@alpha.test");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("money@alpha.test");
    expect(rows[0]!.textContent).toContain("Waiting for sign-in");
    expect(rows[1]!.textContent).toContain("head@alpha.test");
    expect(rows[1]!.textContent).toContain("Active");
  });

  test("invites a finance staff member by email", async () => {
    await renderPage();
    const form = await screen.findByRole("form", {
      name: "Invite a principal or finance staff member",
    });
    fireEvent.change(within(form).getByLabelText(/Email/), {
      target: { value: " new@alpha.test " },
    });
    fireEvent.click(within(form).getByRole("combobox", { name: /Role/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Finance" }));
    fireEvent.click(within(form).getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]).toEqual([
      "/api/invitations",
      { body: { email: "new@alpha.test", role: "FINANCE" } },
    ]);
  });

  test("rejects an invalid email without calling the API", async () => {
    await renderPage();
    const form = await screen.findByRole("form", {
      name: "Invite a principal or finance staff member",
    });
    fireEvent.change(within(form).getByLabelText(/Email/), { target: { value: "not-an-email" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(await within(form).findByText(/valid email/i)).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  test("resends a pending invitation", async () => {
    await renderPage();
    const table = await screen.findByRole("table", { name: "Principal and finance invitations" });
    fireEvent.click(await within(table).findByRole("button", { name: "Resend" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/invitations/{id}/regenerate", {
        params: { path: { id: PENDING_ID } },
      }),
    );
  });

  test("?invite=1 focuses the invite form's email field, then drops the parameter", async () => {
    await renderPage("/portal/accounts?invite=1");

    const email = await screen.findByRole("textbox", { name: /email/i });
    await waitFor(() => expect(document.activeElement).toBe(email));
    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toBe(""));
  });

  test("without ?invite the email field is not focused", async () => {
    await renderPage();

    const email = await screen.findByRole("textbox", { name: /email/i });
    expect(document.activeElement).not.toBe(email);
  });
});
