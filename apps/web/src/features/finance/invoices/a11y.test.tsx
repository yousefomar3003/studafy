import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/** Automated accessibility audit for the invoice screens (ST-202), mirroring `finance/fees/a11y.test.tsx`. */

const INVOICE = {
  id: "invoice-1",
  school_id: "school-1",
  student_id: "student-1",
  student_name: "Layla Haddad",
  admission_number: "ADM-001",
  erpnext_docname: "ACC-SINV-2026-00001",
  erpnext_status: "submitted",
  total_amount: "1000.000",
  total_amount_minor: 1000000,
  outstanding_amount: "1000.000",
  outstanding_amount_minor: 1000000,
  currency: "JOD",
  currency_minor_unit: 3,
  issued_date: "2026-08-01",
  due_date: "2026-09-01",
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const INVOICE_DETAIL = {
  ...INVOICE,
  lines: [{ fee_category: "Tuition", description: null, quantity: 1, amount: 1000 }],
};

const FEE_STRUCTURE = {
  erpnext_name: "FS-2026-0001",
  school_id: "school-1",
  academic_year_id: "year-1",
  program: "Grade 5",
  title: "Grade 5 Fees",
  total_amount: "1000.000",
  total_amount_minor: 1000000,
  currency: "JOD",
  currency_minor_unit: 3,
  erpnext_status: "submitted",
  is_active: true,
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/invoices") {
    return Promise.resolve({ data: { invoices: [INVOICE], next_cursor: null } });
  }
  if (path === "/api/finance/invoices/{invoiceId}") {
    return Promise.resolve({ data: INVOICE_DETAIL });
  }
  if (path === "/api/finance/fee-structures") {
    return Promise.resolve({ data: { fee_structures: [FEE_STRUCTURE], total: 1 } });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve({ data: { classes: [], total: 0 } });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: mock(() => Promise.resolve({ data: undefined })) },
}));

function renderInPortal(Page: ComponentType, initialPath: string, routePath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <main>
            <Routes>
              <Route path={routePath} element={<Page />} />
            </Routes>
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("invoice screens accessibility", () => {
  test("invoice list, populated", async () => {
    const Page = (await import("./InvoiceListPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/invoices",
      "/portal/finance/invoices",
    );
    await screen.findByRole("heading", { name: "Invoices" });
    await screen.findByText("ACC-SINV-2026-00001");

    await expectNoA11yViolations(container);
  });

  test("invoice detail", async () => {
    const Page = (await import("./InvoiceDetailPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/invoices/invoice-1",
      "/portal/finance/invoices/:invoiceId",
    );
    await screen.findByRole("heading", { name: "Invoice ACC-SINV-2026-00001" });

    await expectNoA11yViolations(container);
  });

  test("batch generation form", async () => {
    const Page = (await import("./InvoiceBatchPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/invoices/batches/new",
      "/portal/finance/invoices/batches/new",
    );
    await screen.findByRole("heading", { name: "Generate invoices" });
    await screen.findByText("Grade 5 Fees (1000.000 JOD)");

    await expectNoA11yViolations(container);
  });
});
