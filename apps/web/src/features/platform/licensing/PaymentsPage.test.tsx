import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The console's payments page reads the cross-school invoice list one server page at a time: the
 * first page on load, the next only when asked, appended below the first.
 */

function invoice(n: number) {
  const number = `LIC-2026-${String(n).padStart(6, "0")}`;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    schoolId: "11111111-1111-4111-8111-111111111111",
    schoolName: "Alpha Academy",
    licenseId: "55555555-5555-4555-8555-555555555555",
    quoteId: null,
    number,
    paymentReference: `STF-${n}`,
    status: "issued",
    currencyCode: "USD",
    minorUnit: 2,
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    subtotalMinor: 1000,
    creditTotalMinor: 0,
    adjustmentMinor: 0,
    totalMinor: 1000,
    paidMinor: 0,
    balanceMinor: 1000,
    overdue: false,
    overdueAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: "2026-10-01T08:00:00.000Z",
  };
}

const getMock = mock((path: string, init?: { params?: { query?: { cursor?: string } } }) => {
  if (path === "/api/platform/licenses/invoices") {
    return Promise.resolve({
      data: init?.params?.query?.cursor
        ? { invoices: [invoice(1)], status: "unpaid", nextCursor: null }
        : { invoices: [invoice(3), invoice(2)], status: "unpaid", nextCursor: "page-2" },
    });
  }
  if (path === "/api/platform/licenses/finance") {
    return Promise.resolve({ data: { totals: [], pendingReceipts: 0 } });
  }
  if (path === "/api/platform/licenses/receipts") {
    return Promise.resolve({ data: { receipts: [] } });
  }
  if (path === "/api/platform/schools") {
    return Promise.resolve({ data: { schools: [], total: 0 } });
  }
  throw new Error(`Unhandled GET ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./PaymentsPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function invoiceCursors() {
  return getMock.mock.calls
    .filter(([path]) => path === "/api/platform/licenses/invoices")
    .map(([, init]) => init?.params?.query?.cursor);
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("PaymentsPage", () => {
  test("loads the next page of invoices only when asked, below the first", async () => {
    await renderPage();

    expect(await screen.findByText("LIC-2026-000003")).toBeTruthy();
    expect(screen.getByText("LIC-2026-000002")).toBeTruthy();
    expect(screen.queryByText("LIC-2026-000001")).toBeNull();
    expect(invoiceCursors()).toEqual([undefined]);

    fireEvent.click(screen.getByRole("button", { name: "Show more invoices" }));

    expect(await screen.findByText("LIC-2026-000001")).toBeTruthy();
    expect(invoiceCursors()).toEqual([undefined, "page-2"]);
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["LIC-2026-000003", "LIC-2026-000002", "LIC-2026-000001"]);
    expect(screen.queryByRole("button", { name: "Show more invoices" })).toBeNull();
  });
});
