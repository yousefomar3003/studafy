import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

const SETTINGS = { auto_billing: true, auto_billing_since: null, updated_at: null };
const SUMMARY = {
  students: 1,
  created: 0,
  updated: 1,
  removed: 0,
  unchanged: 0,
  skipped_no_price: 0,
};
const LINE = {
  student_id: "6f1e4a39-87c1-4a76-9a4c-0d36a6a3a2c1",
  student_name: "Lina Haddad",
  admission_number: "ADM-7",
  academic_year_id: "7a1e4a39-87c1-4a76-9a4c-0d36a6a3a2c1",
  academic_year_name: "2026/27",
  currency: "USD",
  currency_minor_unit: 2,
  monthly_price: "6.00",
  monthly_price_minor: 600,
  months: 5,
  total: "30.00",
  total_minor: 3000,
  start_month: "2027-02",
  end_month: "2027-06",
  late_start: true,
  stopped_from: null,
  status: "active",
  billing: "auto",
  invoiced: "0.00",
  invoiced_minor: 0,
  planned: "30.00",
  planned_minor: 3000,
};

const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve({
    data: path === "/api/finance/student-ai/lines" ? { lines: [LINE] } : SETTINGS,
  }),
);
const putMock = mock((_path: string, init?: { body: { auto_billing: boolean } }) =>
  Promise.resolve({
    data: {
      settings: { ...SETTINGS, auto_billing: init?.body.auto_billing ?? true },
      sync: SUMMARY,
    },
  }),
);
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: SUMMARY }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, PUT: putMock, POST: postMock },
}));

afterEach(() => {
  cleanup();
  getMock.mockClear();
  putMock.mockClear();
  postMock.mockClear();
});

const load = async () => (await import("./StudentAiBillingPage")).default;

describe("StudentAiBillingPage", () => {
  test("finance switches auto-billing off and sees each student's line", async () => {
    const Page = await load();
    await renderFinance(<Page />, { roles: ["FINANCE"] });

    expect(await screen.findByText("Lina Haddad (ADM-7)")).toBeTruthy();
    expect(screen.getByText("$6.00/month × 5 months = $30.00")).toBeTruthy();
    expect(screen.getByText("2027-02 to 2027-06")).toBeTruthy();

    const toggle = screen.getByLabelText("Add Student AI to the fee schedule") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(callTo(putMock.mock.calls, "/api/finance/student-ai/settings")?.body).toEqual({
      auto_billing: false,
    });
    expect(await screen.findByText("Student AI billing saved")).toBeTruthy();
    expect(screen.getByText(/Off: Studafy adds nothing to invoices/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Recalculate lines" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Student AI lines recalculated")).toBeTruthy();
  });

  test("a reader without billing:update cannot switch it", async () => {
    const Page = await load();
    await renderFinance(<Page />, { roles: ["PRINCIPAL"] });
    const toggle = await screen.findByLabelText("Add Student AI to the fee schedule");
    expect(toggle.matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Recalculate lines" })).toBeNull();
  });
});
