/**
 * A school's sales tax (VAT) on a Sales Invoice it is about to generate (000173). ERPNext computes
 * the amounts: this adds one "On Net Total" tax row on the school's tax account, so the tax follows
 * any scholarship or sibling discount, and zero-rates the lines of an exempt fee category through
 * each item's `item_tax_rate`. When the school quotes fees with tax included, the row is marked
 * `included_in_print_rate` and ERPNext carves the tax out of the fee instead of adding it on top.
 * Off, or not configured: the payload is left exactly as it was.
 */

export interface SalesTaxSettings {
  is_enabled: boolean;
  tax_name: string;
  /** Decimal string as stored, e.g. "5.00". */
  rate: string;
  erpnext_account_head: string | null;
  prices_include_tax: boolean;
  exempt_fee_categories: string[];
}

export interface SalesInvoiceItem {
  item_code: string;
  qty: number;
  rate: number;
  description?: string;
  item_tax_rate?: string;
}

export function applySalesTax(
  payload: Record<string, unknown> & { items: SalesInvoiceItem[] },
  settings: SalesTaxSettings | null,
): void {
  if (!settings?.is_enabled || !settings.erpnext_account_head) return;
  const rate = Number(settings.rate);
  if (!Number.isFinite(rate) || rate <= 0) return;

  const account = settings.erpnext_account_head;
  const exempt = new Set(settings.exempt_fee_categories);
  for (const item of payload.items) {
    if (exempt.has(item.item_code)) item.item_tax_rate = JSON.stringify({ [account]: 0 });
  }
  payload.taxes = [
    {
      charge_type: "On Net Total",
      account_head: account,
      description: `${settings.tax_name} ${Number(settings.rate)}%`,
      rate,
      included_in_print_rate: settings.prices_include_tax ? 1 : 0,
    },
  ];
}
