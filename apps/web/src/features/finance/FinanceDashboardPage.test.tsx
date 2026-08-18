import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

function emptyReport(reportName: string) {
  return {
    report_name: reportName,
    columns: [],
    rows: [],
    report_summary: [],
    presentation: {
      locale: "en",
      direction: "ltr",
      currency: "JOD",
      currency_precision: 3,
      currency_display: [],
    },
  };
}

/** A real ERPNext report response always carries its report-defined columns, even with zero rows —
 * only `emptyReport`'s bare shape omits them, which `overdueInstallments` correctly treats as "can't
 * tell the shape" rather than "nothing overdue" (see queries.test.ts). This fixture is the honest
 * "no data yet" case for `collections-vs-due`. */
function emptyCollectionsVsDueReport() {
  return {
    ...emptyReport("Accounts Receivable"),
    columns: [
      { fieldname: "party_name", fieldtype: "Data" },
      { fieldname: "due_date", fieldtype: "Date" },
      { fieldname: "outstanding_amount", fieldtype: "Currency" },
    ],
  };
}

function emptyResponsesFor(path: string): Promise<{ data: unknown }> {
  switch (path) {
    case "/api/finance/reports/collections-vs-due":
      return Promise.resolve({ data: emptyCollectionsVsDueReport() });
    case "/api/finance/reports/ar-aging":
      return Promise.resolve({ data: emptyReport("Accounts Receivable Summary") });
    case "/api/finance/payments":
      return Promise.resolve({ data: { payments: [], total: 0 } });
    default:
      return Promise.resolve({ data: undefined });
  }
}

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadFinanceDashboardPage = async (): Promise<ComponentType> =>
  (await import("./FinanceDashboardPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("FinanceDashboardPage", () => {
  test("renders live data from every tile's endpoint", async () => {
    getMock.mockImplementation((path: string) => {
      switch (path) {
        case "/api/finance/reports/collections-vs-due":
          return Promise.resolve({
            data: {
              ...emptyReport("Accounts Receivable"),
              columns: [
                { fieldname: "party_name", fieldtype: "Data" },
                { fieldname: "due_date", fieldtype: "Date" },
                { fieldname: "outstanding_amount", fieldtype: "Currency" },
              ],
              rows: [
                { party_name: "Nour Family", due_date: "2026-07-01", outstanding_amount: 120 },
              ],
              report_summary: [{ label: "Total Collected", value: 5000 }],
              presentation: {
                locale: "en",
                direction: "ltr",
                currency: "JOD",
                currency_precision: 3,
                currency_display: [{ outstanding_amount: "120.000" }],
              },
            },
          });
        case "/api/finance/reports/ar-aging":
          return Promise.resolve({
            data: {
              ...emptyReport("Accounts Receivable Summary"),
              columns: [
                { fieldname: "party_name", fieldtype: "Data" },
                { fieldname: "range1", fieldtype: "Currency", label: "0-30" },
              ],
              rows: [{ party_name: "Nour Family", range1: 120 }],
            },
          });
        case "/api/finance/payments":
          return Promise.resolve({
            data: {
              total: 1,
              payments: [
                {
                  id: "payment-1",
                  school_id: "school-1",
                  student_id: "student-1",
                  erpnext_payment_entry_id: "PE-0001",
                  erpnext_invoice_id: "ACC-SINV-0001",
                  amount: "75.000",
                  amount_minor: 75000,
                  currency: "JOD",
                  currency_minor_unit: 3,
                  payment_mode: "cash",
                  status: "confirmed",
                  erpnext_status: "Submitted",
                  receipt_url: null,
                  payment_date: "2026-08-17",
                  confirmed_at: "2026-08-17T10:00:00.000Z",
                  last_synced_at: "2026-08-17T10:00:00.000Z",
                },
              ],
            },
          });
        default:
          return Promise.resolve({ data: undefined });
      }
    });

    renderPage(await loadFinanceDashboardPage());

    expect(await screen.findByText("Total Collected")).toBeTruthy();
    expect(screen.getByText("5000.000")).toBeTruthy();
    expect(screen.getByText("0-30")).toBeTruthy();
    expect(screen.getByText("Nour Family")).toBeTruthy();
    expect(screen.getByText("75.000 JOD")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
  });

  test("renders each tile's empty state when there is nothing to show yet", async () => {
    getMock.mockImplementation(emptyResponsesFor);

    renderPage(await loadFinanceDashboardPage());

    expect(await screen.findByText("No collections summary for this term yet.")).toBeTruthy();
    expect(screen.getByText("No outstanding receivables to age.")).toBeTruthy();
    expect(screen.getByText("Nothing is overdue.")).toBeTruthy();
    expect(screen.getByText("No payments recorded yet.")).toBeTruthy();
  });
});
