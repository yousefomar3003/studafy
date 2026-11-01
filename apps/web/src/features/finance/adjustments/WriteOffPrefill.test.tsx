import { cleanup, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderFinance } from "../test-utils";

import { capFor } from "./NewRefundPage";

const INVOICE = {
  id: "invoice-1",
  student_id: "student-1",
  student_name: "Omar Saleh",
  admission_number: "ADM-1",
  erpnext_docname: "ACC-SINV-0001",
  erpnext_status: "submitted",
  total_amount: "1000.000",
  total_amount_minor: 1_000_000,
  outstanding_amount: "300.000",
  outstanding_amount_minor: 300_000,
  currency: "JOD",
  currency_minor_unit: 3,
  issued_date: "2026-09-01",
  due_date: null,
  lines: [],
  taxes: [],
  net_total: null,
  tax_registration_number: null,
};

const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve({ data: path === "/api/finance/invoices/{invoiceId}" ? INVOICE : undefined }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: mock() } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("refund form caps", () => {
  test("each reason is capped by what it means", () => {
    expect(capFor("overpayment")).toBe("paid");
    expect(capFor("withdrawal")).toBe("paid");
    expect(capFor("write_off")).toBe("outstanding");
    expect(capFor("error_correction")).toBe("total");
    expect(capFor("discount_adjustment")).toBe("total");
  });

  test("a write-off from an invoice opens on it, at the whole outstanding balance", async () => {
    const Page = (await import("./NewRefundPage")).default;
    await renderFinance(<Page />, {
      path: "/portal/finance/adjustments/refunds/new?invoiceId=invoice-1&reason=write_off",
    });
    expect(
      await screen.findByText("Up to 300.000 JOD is still owed and can be written off."),
    ).toBeTruthy();
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe("300.000");
  });
});
