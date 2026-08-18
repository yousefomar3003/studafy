import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the finance dashboard (ST-200), mirroring
 * `principal/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route.
 */

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
 * see `FinanceDashboardPage.test.tsx`'s fixture of the same name for why this matters here too. */
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

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadFinanceDashboardPage = async (): Promise<ComponentType> =>
  (await import("./FinanceDashboardPage")).default;
const loadFinanceOverdueInstallmentsPage = async (): Promise<ComponentType> =>
  (await import("./FinanceOverdueInstallmentsPage")).default;

function renderInPortal(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <main>
          <Page />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("finance dashboard accessibility", () => {
  test("dashboard, empty state", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/finance/reports/collections-vs-due") {
        return Promise.resolve({ data: emptyCollectionsVsDueReport() });
      }
      if (path === "/api/finance/reports/ar-aging") {
        return Promise.resolve({ data: emptyReport("Accounts Receivable Summary") });
      }
      if (path === "/api/finance/payments") {
        return Promise.resolve({ data: { payments: [], total: 0 } });
      }
      return Promise.resolve({ data: undefined });
    });

    const { container } = renderInPortal(await loadFinanceDashboardPage());
    await screen.findByRole("heading", { name: "Finance" });

    await expectNoA11yViolations(container);
  });

  test("overdue installments drill-through page", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/finance/reports/collections-vs-due") {
        return Promise.resolve({ data: emptyCollectionsVsDueReport() });
      }
      return Promise.resolve({ data: undefined });
    });

    const { container } = renderInPortal(await loadFinanceOverdueInstallmentsPage());
    await screen.findByRole("heading", { name: "Overdue installments" });

    await expectNoA11yViolations(container);
  });
});
