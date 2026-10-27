import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The console's licenses page: every school's license with seats used and the unpaid balance,
 * filtered by status, ending within 30 days, seats nearly full and unpaid; and the inbox of seat
 * change requests -- priced through the calculator, resolved or declined with an optional note.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const LICENSE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const openRequest = {
  id: REQUEST_ID,
  schoolId: SCHOOL_ID,
  schoolName: "Alpha Academy",
  licenseId: LICENSE_ID,
  status: "open",
  studentSeats: 120,
  teacherSeats: null,
  parentSeats: null,
  includeFamilyPlus: true,
  note: "New grade 7 section",
  requestedBy: "44444444-4444-4444-8444-444444444444",
  resolutionNote: null,
  resolvedAt: null,
  createdAt: "2026-10-20T09:00:00.000Z",
};

const consoleLicense = {
  id: LICENSE_ID,
  schoolId: SCHOOL_ID,
  schoolName: "Alpha Academy",
  status: "active",
  currencyCode: "USD",
  minorUnit: 2,
  includeFamilyPlus: false,
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-11-15T00:00:00.000Z",
  activatedAt: "2026-09-01T00:00:00.000Z",
  allowedTransitions: ["suspended", "cancelled"],
  notes: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  createdBy: "55555555-5555-4555-8555-555555555555",
  updatedAt: "2026-08-20T00:00:00.000Z",
  daysLeft: 19,
  seatUse: 0.95,
  balanceMinor: 125_000,
  audiences: [
    {
      audience: "student",
      purchased: 100,
      assigned: 95,
      tier: { id: "t-1", code: "student_plus", displayName: "Student Plus" },
    },
    { audience: "teacher", purchased: 0, assigned: 0, tier: null },
    { audience: "parent", purchased: 0, assigned: 0, tier: null },
  ],
};

type Query = Record<string, unknown> | undefined;

const getMock = mock((path: string, init?: { params?: { query?: Query } }) => {
  if (path === "/api/platform/licenses/change-requests") {
    const status = init?.params?.query?.status;
    return Promise.resolve({
      data: { requests: status === "open" ? [openRequest] : [], status: status ?? "all" },
    });
  }
  if (path === "/api/platform/licenses") {
    return Promise.resolve({ data: { licenses: [consoleLicense] } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/schools/{schoolId}/license-requests/{requestId}/resolve") {
    return Promise.resolve({ data: { ...openRequest, status: "resolved" } });
  }
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./LicensesPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function licenseQueries(): Query[] {
  return getMock.mock.calls
    .filter(([path]) => path === "/api/platform/licenses")
    .map(([, init]) => init?.params?.query);
}

function resolveBodies() {
  return postMock.mock.calls
    .filter(
      ([path]) => path === "/api/platform/schools/{schoolId}/license-requests/{requestId}/resolve",
    )
    .map(([, init]) => init!.body!);
}

async function inbox() {
  return within(await screen.findByRole("region", { name: "Seat change requests" }));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("LicensesPage", () => {
  test("lists each license with seats used, days left and the unpaid balance", async () => {
    await renderPage();
    const table = await screen.findByRole("table", { name: "All licenses" });
    const row = (await within(table).findByRole("link", { name: "Alpha Academy" })).closest("tr")!;
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(within(row).getByText("19 days left")).toBeTruthy();
    expect(within(row).getByText("Students: 95 / 100")).toBeTruthy();
    expect(within(row).getByText("$1,250.00")).toBeTruthy();
  });

  test("filters by status, ending soon, nearly full and unpaid", async () => {
    await renderPage();
    await screen.findByRole("table", { name: "All licenses" });
    expect(licenseQueries()[0]).toEqual({
      status: undefined,
      expiringWithinDays: undefined,
      seatsNearlyFull: undefined,
      unpaid: undefined,
    });

    const filters = within(screen.getByRole("group", { name: "Filter licenses" }));
    fireEvent.click(filters.getByRole("combobox", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Active" }));
    fireEvent.click(filters.getByLabelText("Ending in 30 days"));
    fireEvent.click(filters.getByLabelText("Seats nearly full"));
    fireEvent.click(filters.getByLabelText("Unpaid balance"));

    await waitFor(() =>
      expect(licenseQueries().at(-1)).toEqual({
        status: "active",
        expiringWithinDays: 30,
        seatsNearlyFull: 0.9,
        unpaid: "true",
      }),
    );
  });

  test("shows an open request with what the school wants and a link to price it", async () => {
    await renderPage();
    const box = await inbox();
    expect(await box.findByText("120 student seats · Family+ on")).toBeTruthy();
    expect(box.getByText("“New grade 7 section”")).toBeTruthy();
    expect(box.getByRole("link", { name: "Price it" }).getAttribute("href")).toBe(
      `/portal/platform/quotes?schoolId=${SCHOOL_ID}&licenseId=${LICENSE_ID}&kind=seat_increase`,
    );
  });

  test("resolves a request with a note", async () => {
    await renderPage();
    fireEvent.click(await (await inbox()).findByRole("button", { name: "Resolve" }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve Alpha Academy's request" });
    fireEvent.change(within(dialog).getByLabelText(/Note for the school/), {
      target: { value: "Quote sent for 120 seats" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(resolveBodies()).toEqual([{ status: "resolved", note: "Quote sent for 120 seats" }]),
    );
    const [, init] = postMock.mock.calls[0]!;
    expect((init as unknown as { params: { path: unknown } }).params.path).toEqual({
      schoolId: SCHOOL_ID,
      requestId: REQUEST_ID,
    });
    expect(await screen.findByText("Request resolved.")).toBeTruthy();
  });

  test("declines a request without a note", async () => {
    await renderPage();
    fireEvent.click(await (await inbox()).findByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("dialog", { name: "Decline Alpha Academy's request" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(resolveBodies()).toEqual([{ status: "declined", note: null }]));
    expect(await screen.findByText("Request declined.")).toBeTruthy();
  });

  test("switches the inbox between open, resolved and declined requests", async () => {
    await renderPage();
    const box = await inbox();
    await box.findByText("120 student seats · Family+ on");
    const chips = within(box.getByRole("group", { name: "Show requests" }));
    expect(chips.getByRole("button", { name: "Open" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chips.getByRole("button", { name: "Resolved" }));
    expect(await box.findByText("No resolved requests.")).toBeTruthy();
    expect(
      getMock.mock.calls.some(
        ([path, init]) =>
          path === "/api/platform/licenses/change-requests" &&
          init?.params?.query?.status === "resolved",
      ),
    ).toBe(true);
  });
});
