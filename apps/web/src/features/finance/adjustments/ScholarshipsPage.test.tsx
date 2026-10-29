import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const SCHOLARSHIP = {
  id: "scholarship-1",
  name: "Sibling discount",
  description: null,
  discount_type: "percentage",
  percentage: "10.00",
  amount: null,
  amount_minor: null,
  currency: null,
  currency_minor_unit: null,
  fee_category: null,
  is_active: true,
  approved_award_count: 0,
  created_at: "2026-10-20T00:00:00.000Z",
  updated_at: "2026-10-20T00:00:00.000Z",
};

const AWARD = {
  id: "award-1",
  scholarship_id: "scholarship-1",
  scholarship_name: "Sibling discount",
  discount_type: "percentage",
  percentage: "10.00",
  amount: null,
  currency: null,
  fee_category: null,
  student_id: "student-1",
  student_name: "Lina Haddad",
  admission_number: "A-100",
  status: "pending_approval",
  notes: "Brother in grade 5",
  requested_by: "finance-1",
  requested_by_name: "Finance Officer",
  decided_by: null,
  decided_by_name: null,
  decided_at: null,
  decision_notes: null,
  created_at: "2026-10-21T00:00:00.000Z",
  updated_at: "2026-10-21T00:00:00.000Z",
};

const getMock = mock((path: string, _init?: { params: { query: { status?: string } } }) => {
  if (path === "/api/finance/scholarships") {
    return Promise.resolve({ data: { scholarships: [SCHOLARSHIP], total: 1 } });
  }
  if (path === "/api/finance/scholarship-awards") {
    return Promise.resolve({ data: { awards: [AWARD], total: 1 } });
  }
  if (path === "/api/finance/students") {
    return Promise.resolve({
      data: { students: [{ id: "student-1", name: "Lina Haddad", admission_number: "A-100" }] },
    });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/finance/scholarships") {
    return Promise.resolve({ data: SCHOLARSHIP });
  }
  if (path === "/api/finance/scholarship-awards") {
    return Promise.resolve({ data: AWARD });
  }
  if (path === "/api/finance/scholarship-awards/{awardId}/approve") {
    return Promise.resolve({ data: { ...AWARD, status: "approved", decided_by: "admin-1" } });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: mock(() => Promise.resolve({ data: undefined })) },
}));

const loadPage = async (): Promise<ComponentType> => (await import("./ScholarshipsPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

/** Renders the router's current `search`, so a test can see a query parameter being dropped. */
function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

async function renderAs(
  role: "ORG_ADMIN" | "FINANCE",
  initialEntry = "/portal/finance/scholarships",
) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role], sub: `${role.toLowerCase()}-1` }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Page />
            <LocationProbe />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("ScholarshipsPage", () => {
  test("the school admin sees the approval queue and approves an award", async () => {
    await renderAs("ORG_ADMIN");

    const row = (await screen.findByText("Lina Haddad")).closest("tr")!;
    expect(within(row).getByText("10% off all fees")).toBeTruthy();
    // The admin lands on what needs them.
    expect(
      getMock.mock.calls.some(
        ([path, init]) =>
          path === "/api/finance/scholarship-awards" &&
          init?.params.query.status === "pending_approval",
      ),
    ).toBe(true);

    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

    await screen.findByText("Scholarship approved");
    expect(postMock).toHaveBeenCalledWith("/api/finance/scholarship-awards/{awardId}/approve", {
      params: { path: { awardId: "award-1" } },
      body: { notes: undefined },
    });
  });

  test("rejecting requires a reason", async () => {
    await renderAs("ORG_ADMIN");
    const row = (await screen.findByText("Lina Haddad")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await within(dialog).findByText("Enter a reason. Finance will see it.")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  test("finance can request awards but not decide them", async () => {
    await renderAs("FINANCE");
    const row = (await screen.findByText("Lina Haddad")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Award to a student" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New scholarship" })).toBeTruthy();
  });

  test("finance creates a scholarship and requests it for the students picked in the form", async () => {
    await renderAs("FINANCE");
    fireEvent.click(await screen.findByRole("button", { name: "New scholarship" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Name", { exact: false }), {
      target: { value: "Sibling discount" },
    });
    fireEvent.change(within(dialog).getByLabelText("Percentage off", { exact: false }), {
      target: { value: "10" },
    });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Students (optional)" }));
    fireEvent.click(await within(dialog).findByRole("option", { name: "Lina Haddad" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create scholarship" }));

    await screen.findByText("Sent 1 student to the school admin for approval.");
    expect(postMock).toHaveBeenCalledWith("/api/finance/scholarships", {
      body: { name: "Sibling discount", discount_type: "percentage", percentage: 10 },
    });
    expect(postMock).toHaveBeenCalledWith("/api/finance/scholarship-awards", {
      body: { scholarship_id: "scholarship-1", student_id: "student-1" },
    });
  });

  test("?award=1 opens 'award to a student' once the catalog loads; closing drops it", async () => {
    await renderAs("FINANCE", "/portal/finance/scholarships?award=1");

    const dialog = await screen.findByRole("dialog", { name: "Award a scholarship" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Award a scholarship" })).toBeNull(),
    );
    expect(screen.getByTestId("location-search").textContent).toBe("");
  });
});
