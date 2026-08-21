import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/** Automated accessibility audit for the expense screens, mirroring `payments/a11y.test.tsx`. */

const EXPENSE = {
  id: "expense-1",
  school_id: "school-1",
  document_type: "purchase_invoice",
  category: "Office Supplies",
  vendor: "Amman Stationery Co.",
  description: "Printer paper and toner",
  amount: "42.500",
  amount_minor: 42500,
  currency: "JOD",
  currency_minor_unit: 3,
  erpnext_name: "PINV-0001",
  erpnext_status: "submitted",
  attachment_url: "https://storage.example.com/permanent/school-1/receipt.pdf",
  expense_date: "2026-08-21",
  last_synced_at: "2026-08-21T00:00:00.000Z",
};

const SUMMARY = {
  year: 2026,
  month: 8,
  categories: [
    { category: "Office Supplies", total_amount: "42.500", total_amount_minor: 42500, count: 1 },
  ],
  grand_total: "42.500",
  grand_total_minor: 42500,
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/expenses") {
    return Promise.resolve({ data: { expenses: [EXPENSE], total: 1 } });
  }
  if (path === "/api/finance/expenses/summary") {
    return Promise.resolve({ data: SUMMARY });
  }
  if (path === "/api/finance/expenses/{expenseId}") {
    return Promise.resolve({ data: EXPENSE });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string) => {
  if (path === "/api/finance/expenses") {
    return Promise.resolve({ data: EXPENSE });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

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
  postMock.mockClear();
});

describe("expense screens accessibility", () => {
  test("expense list, populated with the monthly summary", async () => {
    const Page = (await import("./ExpenseListPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/expenses",
      "/portal/finance/expenses",
    );
    await screen.findByRole("heading", { name: "Expenses" });
    await screen.findByRole("link", { name: "Office Supplies" });
    await screen.findByRole("heading", { name: /Monthly summary/ });

    await expectNoA11yViolations(container);
  });

  test("new expense form, filled out", async () => {
    const Page = (await import("./NewExpensePage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/expenses/new",
      "/portal/finance/expenses/new",
    );
    await screen.findByRole("heading", { name: "Record an expense" });

    fireEvent.click(screen.getByRole("combobox", { name: "Document type" }));
    fireEvent.click(screen.getByRole("option", { name: "Purchase invoice" }));
    fireEvent.change(screen.getByLabelText("Expense account", { exact: false }), {
      target: { value: "Office Supplies" },
    });
    fireEvent.change(screen.getByLabelText("Supplier", { exact: false }), {
      target: { value: "Amman Stationery Co." },
    });
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "42.5" },
    });

    await expectNoA11yViolations(container);
  });

  test("expense recorded, success panel", async () => {
    const Page = (await import("./NewExpensePage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/expenses/new",
      "/portal/finance/expenses/new",
    );
    await screen.findByRole("heading", { name: "Record an expense" });

    fireEvent.click(screen.getByRole("combobox", { name: "Document type" }));
    fireEvent.click(screen.getByRole("option", { name: "Purchase invoice" }));
    fireEvent.change(screen.getByLabelText("Expense account", { exact: false }), {
      target: { value: "Office Supplies" },
    });
    fireEvent.change(screen.getByLabelText("Supplier", { exact: false }), {
      target: { value: "Amman Stationery Co." },
    });
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "42.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record expense" }));

    await screen.findByText("Expense recorded — 42.500 JOD");

    await expectNoA11yViolations(container);
  });

  test("expense detail, with a receipt attached", async () => {
    const Page = (await import("./ExpenseDetailPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/expenses/expense-1",
      "/portal/finance/expenses/:expenseId",
    );
    await screen.findByRole("heading", { name: "Office Supplies" });
    await screen.findByRole("link", { name: "View receipt" });

    await expectNoA11yViolations(container);
  });
});
