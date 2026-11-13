import { cleanup, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderFinance } from "../test-utils";

const invoice = (id: string, status: string, outstandingMinor: number) => ({
  id,
  student_id: "student-1",
  student_name: "Omar Saleh",
  admission_number: "ADM-1",
  erpnext_docname: `ACC-SINV-${id}`,
  erpnext_status: status,
  total_amount: "500.000",
  total_amount_minor: 500_000,
  outstanding_amount: (outstandingMinor / 1000).toFixed(3),
  outstanding_amount_minor: outstandingMinor,
  currency: "JOD",
  currency_minor_unit: 3,
  issued_date: "2026-09-01",
  due_date: "2026-09-30",
  family_id: null,
  family_name: null,
});

const getMock = mock((path: string, _init?: unknown) => {
  const data: Record<string, unknown> = {
    "/api/finance/students/{studentId}": {
      id: "student-1",
      name: "Omar Saleh",
      admission_number: "ADM-1",
      status: "withdrawn",
      family_id: "family-1",
      family_name: "Saleh family",
    },
    // A cancelled invoice is not owed; the two submitted ones are.
    "/api/finance/invoices": {
      invoices: [
        invoice("1", "submitted", 200_000),
        invoice("2", "submitted", 50_000),
        invoice("3", "cancelled", 500_000),
      ],
      next_cursor: null,
    },
    "/api/finance/students/{studentId}/installments": { installments: [], total: 0 },
    "/api/finance/payments": { payments: [], total: 0, totals: [] },
    "/api/finance/refunds": { refunds: [], total: 0 },
  };
  return Promise.resolve({ data: data[path] });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: mock() } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("StudentFinancePage", () => {
  test("shows a withdrawn student's family, what is owed and every section", async () => {
    const Page = (await import("./StudentFinancePage")).default;
    await renderFinance(<Page />, {
      path: "/portal/finance/students/student-1",
      routePath: "/portal/finance/students/:studentId",
    });

    await screen.findByRole("heading", { name: "Omar Saleh" });
    expect(screen.getByText(/Withdrawn/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Saleh family" }).getAttribute("href")).toBe(
      "/portal/finance/families/family-1",
    );
    expect(await screen.findByText("250.000 JOD")).toBeTruthy();

    const [invoices] = screen.getAllByRole("region", { name: "Invoices" });
    expect(within(invoices!).getByRole("link", { name: "ACC-SINV-1" })).toBeTruthy();
    expect(screen.getByText("No installments scheduled.")).toBeTruthy();
    expect(screen.getByText("No payments yet.")).toBeTruthy();
    expect(screen.getByText("None requested.")).toBeTruthy();

    const query = (
      getMock.mock.calls.find(([path]) => path === "/api/finance/invoices")?.[1] as {
        params: { query: Record<string, unknown> };
      }
    ).params.query;
    expect(query.student_id).toBe("student-1");
  });
});
