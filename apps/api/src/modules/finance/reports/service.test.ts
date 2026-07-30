// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { ERP_REPORT_NAMES, runFinanceReport } from "./service";

import type { TenantErpNext } from "../client/tenant-client";

describe("finance report ERPNext proxy", () => {
  test("uses fixed report names and preserves ERPNext report values", async () => {
    expect(ERP_REPORT_NAMES).toEqual({
      arAging: "Accounts Receivable Summary",
      generalLedger: "General Ledger",
      collections: "Accounts Receivable",
    });

    const calls: unknown[][] = [];
    const erpnext = {
      post: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({
          data: {
            message: {
              columns: [{ fieldname: "outstanding", fieldtype: "Currency" }],
              result: [{ outstanding: "12.3456", age: 31 }],
              report_summary: [{ label: "Outstanding", value: "12.3456" }],
            },
          },
          status: 200,
          headers: new Headers(),
        });
      },
    } as unknown as TenantErpNext;

    const result = await runFinanceReport(
      erpnext,
      ERP_REPORT_NAMES.arAging,
      { company: "TENANT-COMPANY", range1: 30, range2: 60, range3: 90 },
      "ar",
      "ar-JO,ar;q=0.9",
    );

    expect(calls).toEqual([
      [
        "/api/method/frappe.desk.query_report.run",
        {
          report_name: "Accounts Receivable Summary",
          filters: { company: "TENANT-COMPANY", range1: 30, range2: 60, range3: 90 },
          ignore_prepared_report: 1,
        },
        { locale: "ar", acceptLanguage: "ar-JO,ar;q=0.9" },
      ],
    ]);
    expect(result.columns).toEqual([{ fieldname: "outstanding", fieldtype: "Currency" }]);
    expect(result.rows).toEqual([{ outstanding: "12.3456", age: 31 }]);
    expect(result.report_summary).toEqual([{ label: "Outstanding", value: "12.3456" }]);
    expect(result.presentation).toMatchObject({
      locale: "ar",
      direction: "rtl",
      currency: "JOD",
      currency_precision: 3,
      currency_display: [{ outstanding: "12.345" }],
    });
  });
});
