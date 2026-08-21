// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { cellDisplay, columnAlign, reportColumns } from "./erp-report";

import type { FinanceReportResponse } from "../queries";

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
  };
}

describe("reportColumns", () => {
  test("keeps only well-formed column objects", () => {
    const result = reportColumns(
      report({ columns: [{ fieldname: "a", label: "A" }, "not-a-column", null, 42] }),
    );
    expect(result).toEqual([{ fieldname: "a", label: "A" }]);
  });
});

describe("cellDisplay", () => {
  test("reads a positional (array) row by column index", () => {
    const r = report({
      columns: [{ fieldname: "party_name", fieldtype: "Data" }],
      rows: [["Nour Family"]],
    });
    expect(cellDisplay(r, 0, { fieldname: "party_name", fieldtype: "Data" }, 0)).toBe(
      "Nour Family",
    );
  });

  test("reads a keyed (dict) row by fieldname", () => {
    const r = report({
      columns: [{ fieldname: "party_name", fieldtype: "Data" }],
      rows: [{ party_name: "Haddad Family" }],
    });
    expect(cellDisplay(r, 0, { fieldname: "party_name", fieldtype: "Data" }, 0)).toBe(
      "Haddad Family",
    );
  });

  test("prefers the API's own currency_display string over formatting the raw number again", () => {
    const r = report({
      columns: [{ fieldname: "outstanding_amount", fieldtype: "Currency" }],
      rows: [{ outstanding_amount: 120 }],
      presentation: {
        locale: "en",
        direction: "ltr",
        currency: "JOD",
        currency_precision: 3,
        currency_display: [{ outstanding_amount: "120.000" }],
      },
    });
    expect(cellDisplay(r, 0, { fieldname: "outstanding_amount", fieldtype: "Currency" }, 0)).toBe(
      "120.000",
    );
  });

  test("falls back to the raw value when there is no matching currency_display entry", () => {
    const r = report({
      columns: [{ fieldname: "outstanding_amount", fieldtype: "Currency" }],
      rows: [{ outstanding_amount: 120 }],
    });
    expect(cellDisplay(r, 0, { fieldname: "outstanding_amount", fieldtype: "Currency" }, 0)).toBe(
      "120",
    );
  });

  test("renders a missing value as an em dash, not blank or 'undefined'", () => {
    const r = report({
      columns: [{ fieldname: "voucher_no", fieldtype: "Data" }],
      rows: [{}],
    });
    expect(cellDisplay(r, 0, { fieldname: "voucher_no", fieldtype: "Data" }, 0)).toBe("—");
  });
});

describe("columnAlign", () => {
  test("right-aligns numeric-shaped columns", () => {
    expect(columnAlign({ fieldtype: "Currency" })).toBe("end");
    expect(columnAlign({ fieldtype: "Int" })).toBe("end");
    expect(columnAlign({ fieldtype: "Float" })).toBe("end");
  });

  test("left-aligns everything else", () => {
    expect(columnAlign({ fieldtype: "Data" })).toBe("start");
    expect(columnAlign({})).toBe("start");
  });
});
