import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

function makeExpense(overrides: Record<string, unknown> = {}) {
  return {
    id: "expense-1",
    school_id: "school-1",
    document_type: "purchase_invoice",
    category: "Utilities",
    vendor: "Water Co",
    amount: "40.000",
    amount_minor: 40_000,
    currency: "JOD",
    currency_minor_unit: 3,
    description: null,
    expense_date: "2026-10-01",
    erpnext_name: "PINV-0001",
    erpnext_status: "draft",
    attachment_url: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

let expense = makeExpense();

const getMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: expense }));
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: expense }));

mock.module("../../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock, POST: mock() } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
  patchMock.mockClear();
  expense = makeExpense();
});

async function renderPage(roles: string[] = ["FINANCE"]) {
  const Page = (await import("./ExpenseDetailPage")).default;
  return renderFinance(<Page />, {
    roles,
    path: "/portal/finance/expenses/expense-1",
    routePath: "/portal/finance/expenses/:expenseId",
  });
}

describe("ExpenseDetailPage", () => {
  test("a draft expense is corrected and sent to ERPNext", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit expense" }));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "45.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(callTo(patchMock.mock.calls, "/api/finance/expenses/{expenseId}")).toEqual({
      params: { path: { expenseId: "expense-1" } },
      body: {
        category: "Utilities",
        vendor: "Water Co",
        amount: 45.5,
        currency: "JOD",
        expense_date: "2026-10-01",
        description: undefined,
      },
    });
  });

  test("a submitted expense offers no edit, but a receipt can still be attached", async () => {
    expense = makeExpense({ erpnext_status: "submitted" });
    await renderPage();
    await screen.findByRole("heading", { name: "Utilities" });
    expect(screen.queryByRole("button", { name: "Edit expense" })).toBeNull();
    expect(screen.getByLabelText("Attach a receipt")).toBeTruthy();
  });

  test("a read-only role can neither edit nor attach", async () => {
    await renderPage(["SUPPORT_AGENT"]);
    await screen.findByRole("heading", { name: "Utilities" });
    expect(screen.queryByRole("button", { name: "Edit expense" })).toBeNull();
    expect(screen.queryByLabelText("Attach a receipt")).toBeNull();
  });
});
