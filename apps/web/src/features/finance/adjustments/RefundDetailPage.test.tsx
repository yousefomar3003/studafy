import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderFinance } from "../test-utils";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "refund-1",
    school_id: "school-1",
    kind: "invoice_cancellation",
    payment_entry_id: null,
    erpnext_invoice_id: "ACC-SINV-0001",
    erpnext_credit_note_id: null,
    student_id: "student-1",
    amount: "1050.000",
    amount_minor: 1_050_000,
    currency: "JOD",
    currency_minor_unit: 3,
    reason_code: "error_correction",
    reason_notes: "Billed the wrong structure",
    status: "pending_approval",
    maker_id: "user-other",
    checker_id: null,
    approved_at: null,
    completed_at: null,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

let request = makeRequest();

const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve({ data: path === "/api/finance/refunds/{refundId}" ? request : undefined }),
);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve({ data: makeRequest({ status: "completed" }) }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

async function renderPage(roles: string[]) {
  const Page = (await import("./RefundDetailPage")).default;
  return renderFinance(<Page />, {
    roles,
    path: "/portal/finance/adjustments/refunds/refund-1",
    routePath: "/portal/finance/adjustments/refunds/:refundId",
  });
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  request = makeRequest();
});

describe("RefundDetailPage", () => {
  test("a school admin approves a cancellation after reading what it does", async () => {
    await renderPage(["ORG_ADMIN"]);
    await screen.findByRole("heading", { name: "Invoice cancellation" });
    expect(screen.getByText("Billed the wrong structure")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve refund?" });
    expect(dialog.textContent).toContain("This cancels the invoice in ERPNext");

    fireEvent.click(screen.getByRole("button", { name: "Approve refund" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![0]).toBe("/api/finance/refunds/{refundId}/approve");
  });

  test("finance, who asked, cannot decide it", async () => {
    await renderPage(["FINANCE"]);
    await screen.findByRole("heading", { name: "Invoice cancellation" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("the maker cannot approve their own request", async () => {
    request = makeRequest({ maker_id: "user-1" });
    await renderPage(["ORG_ADMIN"]);
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
  });
});
