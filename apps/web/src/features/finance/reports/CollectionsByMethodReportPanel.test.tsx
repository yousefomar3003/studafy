import { cleanup, fireEvent, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderFinance } from "../test-utils";

import { pivotCollections } from "./CollectionsByMethodReportPanel";

const REPORT = {
  from_date: "2026-10-01",
  to_date: "2026-10-02",
  rows: [
    {
      date: "2026-10-01",
      currency: "JOD",
      payment_mode: "cash",
      amount: "15.000",
      amount_minor: 15_000,
      count: 2,
    },
    {
      date: "2026-10-01",
      currency: "JOD",
      payment_mode: null,
      amount: "1.500",
      amount_minor: 1_500,
      count: 1,
    },
    {
      date: "2026-10-02",
      currency: "JOD",
      payment_mode: "bank_transfer",
      amount: "20.000",
      amount_minor: 20_000,
      count: 1,
    },
  ],
  totals: [
    { currency: "JOD", payment_mode: "cash", amount: "15.000", amount_minor: 15_000, count: 2 },
    { currency: "JOD", payment_mode: null, amount: "1.500", amount_minor: 1_500, count: 1 },
    {
      currency: "JOD",
      payment_mode: "bank_transfer",
      amount: "20.000",
      amount_minor: 20_000,
      count: 1,
    },
  ],
};

const getMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: REPORT }));
mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("collections by method", () => {
  test("pivots to one row per day with a column per method, unknown methods as other", () => {
    const days = pivotCollections(REPORT.rows as never, (row) => ("date" in row ? row.date : ""));
    expect(days.map((d) => [d.label, d.byMode, d.total, d.unit])).toEqual([
      ["2026-10-01", { cash: 15_000, bank_transfer: 0, card_external: 0, other: 1_500 }, 16_500, 3],
      ["2026-10-02", { cash: 0, bank_transfer: 20_000, card_external: 0, other: 0 }, 20_000, 3],
    ]);
  });

  test("runs for the chosen range and shows the range total", async () => {
    const Panel = (await import("./CollectionsByMethodReportPanel")).default;
    await renderFinance(<Panel />, { roles: ["FINANCE"] });

    fireEvent.change(screen.getByLabelText("From date", { exact: false }), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("To date", { exact: false }), {
      target: { value: "2026-10-02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));

    expect(await screen.findByText("36.500 JOD")).toBeTruthy();
    expect(
      (getMock.mock.calls[0]![1] as { params: { query: Record<string, string> } }).params.query,
    ).toEqual({ from_date: "2026-10-01", to_date: "2026-10-02" });
  });
});
