import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

const PAYMENT = {
  id: "payment-1",
  school_id: "school-1",
  student_id: "student-1",
  erpnext_payment_entry_id: "ACC-PAY-0001",
  erpnext_invoice_id: "ACC-SINV-0001",
  amount: "250.000",
  amount_minor: 250_000,
  currency: "JOD",
  currency_minor_unit: 3,
  payment_mode: "cash",
  status: "confirmed",
  erpnext_status: "submitted",
  receipt_url: null,
  payment_date: "2026-10-01",
  confirmed_at: "2026-10-01T09:00:00.000Z",
  last_synced_at: "2026-10-01T09:00:00.000Z",
  student_name: "Omar Saleh",
  family_id: null,
  family_name: null,
};

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/finance/payments") {
    return Promise.resolve({
      data: {
        payments: [PAYMENT],
        total: 1,
        totals: [{ currency: "JOD", amount: "250.000", amount_minor: 250_000, count: 1 }],
      },
    });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string, _init?: unknown) =>
  Promise.resolve({
    data:
      path === "/api/finance/payments/{paymentId}/reversal"
        ? { id: "refund-1", kind: "payment_reversal", status: "pending_approval" }
        : undefined,
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async () => (await import("./PaymentsListPage")).default;

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

function lastQuery(): Record<string, unknown> {
  const calls = getMock.mock.calls.filter(([path]) => path === "/api/finance/payments");
  return (calls.at(-1)?.[1] as { params: { query: Record<string, unknown> } }).params.query;
}

describe("PaymentsListPage", () => {
  test("filters by method, dates and search, and shows the confirmed total", async () => {
    const Page = await loadPage();
    await renderFinance(<Page />);

    expect(await screen.findByText("Confirmed: 250.000 JOD from 1 payment")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Omar Saleh" }).getAttribute("href")).toBe(
      "/portal/finance/students/student-1",
    );

    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Paid to"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Method" }));
    fireEvent.click(await screen.findByRole("option", { name: "Bank transfer" }));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: " haddad " } });

    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        date_from: "2026-10-01",
        date_to: "2026-10-31",
        payment_mode: "bank_transfer",
        search: "haddad",
        offset: 0,
      }),
    );
  });

  test("finance asks to reverse a confirmed payment, with a reason", async () => {
    const Page = await loadPage();
    await renderFinance(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: "Reverse" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask to reverse this payment?" });
    expect(dialog.textContent).toContain("ACC-PAY-0001 · 250.000 JOD");

    // A reason is required.
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask to reverse" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Why/), {
      target: { value: "Recorded against the wrong family" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask to reverse" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(callTo(postMock.mock.calls, "/api/finance/payments/{paymentId}/reversal")).toEqual({
      params: { path: { paymentId: "payment-1" } },
      body: { reason_code: "error_correction", reason_notes: "Recorded against the wrong family" },
    });
    expect(await screen.findByText("Reversal sent for approval")).toBeTruthy();
  });

  test("a read-only role sees no reverse action", async () => {
    const Page = await loadPage();
    await renderFinance(<Page />, { roles: ["SUPPORT_AGENT"] });

    await screen.findByText("Omar Saleh");
    expect(screen.queryByRole("button", { name: "Reverse" })).toBeNull();
  });
});
