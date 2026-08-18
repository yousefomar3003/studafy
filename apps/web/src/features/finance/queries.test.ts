// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  agingBuckets,
  bucketForDaysOverdue,
  daysBetween,
  formatAmount,
  overdueInstallments,
  reportSummaryCards,
} from "./queries";

import type { FinanceReportResponse } from "./queries";

function report(overrides: Partial<FinanceReportResponse>): FinanceReportResponse {
  return {
    report_name: "Test Report",
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
    ...overrides,
  } as FinanceReportResponse;
}

describe("agingBuckets", () => {
  const arAgingReport = report({
    columns: [
      { fieldname: "party_name", fieldtype: "Data", label: "Customer" },
      { fieldname: "range1", fieldtype: "Currency", label: "0-30" },
      { fieldname: "range2", fieldtype: "Currency", label: "31-60" },
      { fieldname: "range3", fieldtype: "Currency", label: "61-90" },
      { fieldname: "range4", fieldtype: "Currency", label: "90-Above" },
    ],
    rows: [
      { party_name: "Family A", range1: 100, range2: 0, range3: 0, range4: 0 },
      { party_name: "Family B", range1: 25, range2: 50, range3: 0, range4: 0 },
    ],
  });

  test("sums each ERPNext-named range column across every row, using ERPNext's own labels", () => {
    expect(agingBuckets(arAgingReport)).toEqual([
      { fieldname: "range1", label: "0-30", total: 125 },
      { fieldname: "range2", label: "31-60", total: 50 },
      { fieldname: "range3", label: "61-90", total: 0 },
      { fieldname: "range4", label: "90-Above", total: 0 },
    ]);
  });

  test("reads positional (array) rows the same way as dict rows", () => {
    const positional = report({
      columns: arAgingReport.columns,
      rows: [
        ["Family A", 100, 0, 0, 0],
        ["Family B", 25, 50, 0, 0],
      ],
    });
    expect(agingBuckets(positional).map((bucket) => bucket.total)).toEqual([125, 50, 0, 0]);
  });

  test("ignores non-currency and non-range columns", () => {
    const withExtras = report({
      columns: [
        { fieldname: "party_name", fieldtype: "Data" },
        { fieldname: "advance_amount", fieldtype: "Currency" },
        { fieldname: "range1", fieldtype: "Currency", label: "0-30" },
      ],
      rows: [{ party_name: "A", advance_amount: 999, range1: 10 }],
    });
    expect(agingBuckets(withExtras)).toEqual([{ fieldname: "range1", label: "0-30", total: 10 }]);
  });

  test("returns no buckets when the report carries none", () => {
    expect(agingBuckets(report({}))).toEqual([]);
  });
});

describe("bucketForDaysOverdue", () => {
  test.each<[number, string]>([
    [0, "range1"],
    [30, "range1"],
    [31, "range2"],
    [60, "range2"],
    [61, "range3"],
    [90, "range3"],
    [91, "range4"],
  ])("%i days overdue -> %s", (days, bucket) => {
    expect(bucketForDaysOverdue(days)).toBe(bucket);
  });
});

describe("daysBetween", () => {
  test("counts whole days between two calendar dates", () => {
    expect(daysBetween("2026-07-01", "2026-08-18")).toBe(48);
  });

  test("is zero for the same date", () => {
    expect(daysBetween("2026-08-18", "2026-08-18")).toBe(0);
  });
});

describe("overdueInstallments", () => {
  const TODAY = "2026-08-18";

  const collectionsReport = report({
    columns: [
      { fieldname: "party_name", fieldtype: "Data" },
      { fieldname: "due_date", fieldtype: "Date" },
      { fieldname: "outstanding_amount", fieldtype: "Currency" },
      { fieldname: "voucher_no", fieldtype: "Data" },
    ],
    rows: [
      // Past due with a balance owed - included.
      {
        party_name: "Family A",
        due_date: "2026-07-01",
        outstanding_amount: 100,
        voucher_no: "ACC-SINV-0001",
      },
      // Past due but fully paid - excluded.
      {
        party_name: "Family B",
        due_date: "2026-07-15",
        outstanding_amount: 0,
        voucher_no: "ACC-SINV-0002",
      },
      // Not due yet - excluded regardless of outstanding balance.
      {
        party_name: "Family C",
        due_date: "2026-09-01",
        outstanding_amount: 50,
        voucher_no: "ACC-SINV-0003",
      },
      // A second overdue row, due earlier than Family A - sorts first.
      {
        party_name: "Family D",
        due_date: "2026-06-01",
        outstanding_amount: 30,
        voucher_no: "ACC-SINV-0004",
      },
    ],
    presentation: {
      locale: "en",
      direction: "ltr",
      currency: "JOD",
      currency_precision: 3,
      currency_display: [
        { outstanding_amount: "100.000" },
        {},
        {},
        { outstanding_amount: "30.000" },
      ],
    },
  });

  test("keeps only rows past due with a balance owed, oldest due date first", () => {
    const installments = overdueInstallments(collectionsReport, TODAY);
    expect(installments).not.toBeNull();
    expect(installments?.map((installment) => installment.partyName)).toEqual([
      "Family D",
      "Family A",
    ]);
  });

  test("computes days overdue and the matching aging bucket", () => {
    const [first] = overdueInstallments(collectionsReport, TODAY) ?? [];
    expect(first?.daysOverdue).toBe(daysBetween("2026-06-01", TODAY));
    expect(first?.bucket).toBe(bucketForDaysOverdue(daysBetween("2026-06-01", TODAY)));
  });

  test("prefers the API's own formatted currency string over a client-formatted one", () => {
    const [, second] = overdueInstallments(collectionsReport, TODAY) ?? [];
    expect(second?.outstandingDisplay).toBe("100.000");
  });

  test("returns null when the report has no due-date or outstanding-amount column", () => {
    expect(
      overdueInstallments(report({ columns: [{ fieldname: "party_name" }] }), TODAY),
    ).toBeNull();
  });
});

describe("reportSummaryCards", () => {
  test("formats numeric values at the report's own currency precision and passes strings through", () => {
    const summaryReport = report({
      report_summary: [
        { label: "Total Outstanding", value: 1234.5 },
        { label: "Collected", value: "500.000" },
        { value: 42 },
      ],
    });

    expect(reportSummaryCards(summaryReport)).toEqual([
      { label: "Total Outstanding", display: "1234.500" },
      { label: "Collected", display: "500.000" },
      { label: "", display: "42.000" },
    ]);
  });
});

describe("formatAmount", () => {
  test("uses the report's currency_precision rather than a hardcoded exponent", () => {
    expect(formatAmount(12.3, report({}))).toBe("12.300");
  });
});
