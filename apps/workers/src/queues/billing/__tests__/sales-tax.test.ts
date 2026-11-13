// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { applySalesTax, type SalesInvoiceItem, type SalesTaxSettings } from "../sales-tax";

const SETTINGS: SalesTaxSettings = {
  is_enabled: true,
  tax_name: "VAT",
  rate: "5.00",
  erpnext_account_head: "VAT 5% - SCH",
  prices_include_tax: false,
  exempt_fee_categories: ["Tuition"],
};

function payload() {
  const items: SalesInvoiceItem[] = [
    { item_code: "Tuition", qty: 1, rate: 1000 },
    { item_code: "Transport", qty: 1, rate: 200 },
  ];
  return { customer: "CUST-1", items } as Record<string, unknown> & { items: SalesInvoiceItem[] };
}

describe("applySalesTax", () => {
  test("adds one tax row on the net total and zero-rates the exempt category", () => {
    const doc = payload();
    applySalesTax(doc, SETTINGS);
    expect(doc.taxes).toEqual([
      {
        charge_type: "On Net Total",
        account_head: "VAT 5% - SCH",
        description: "VAT 5%",
        rate: 5,
        included_in_print_rate: 0,
      },
    ]);
    expect(doc.items[0]!.item_tax_rate).toBe(JSON.stringify({ "VAT 5% - SCH": 0 }));
    expect(doc.items[1]!.item_tax_rate).toBeUndefined();
  });

  test("marks the row as included when fees are quoted with tax", () => {
    const doc = payload();
    applySalesTax(doc, {
      ...SETTINGS,
      prices_include_tax: true,
      rate: "15.00",
      tax_name: "ضريبة القيمة المضافة",
    });
    expect(doc.taxes).toEqual([
      expect.objectContaining({
        rate: 15,
        included_in_print_rate: 1,
        description: "ضريبة القيمة المضافة 15%",
      }),
    ]);
  });

  test("leaves the invoice untouched when tax is off, unconfigured, or has no account", () => {
    for (const settings of [
      null,
      { ...SETTINGS, is_enabled: false },
      { ...SETTINGS, erpnext_account_head: null },
      { ...SETTINGS, rate: "0.00" },
    ]) {
      const doc = payload();
      applySalesTax(doc, settings);
      expect(doc).toEqual(payload());
    }
  });
});
