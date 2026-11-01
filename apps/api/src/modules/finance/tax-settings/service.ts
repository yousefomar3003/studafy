/**
 * A school's sales tax (VAT) on fees (000178). Read by the billing worker when it generates an
 * invoice; changing it never touches an invoice already issued.
 */

import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { TaxSettings, UpdateTaxSettingsBody } from "./schemas";
import type { TransactionSql } from "postgres";

const UNCONFIGURED: TaxSettings = {
  configured: false,
  is_enabled: false,
  tax_name: "VAT",
  rate: 0,
  erpnext_account_head: null,
  registration_number: null,
  prices_include_tax: false,
  exempt_fee_categories: [],
  updated_by: null,
  updated_at: null,
};

interface RawRow {
  is_enabled: boolean;
  tax_name: string;
  rate: string;
  erpnext_account_head: string | null;
  registration_number: string | null;
  prices_include_tax: boolean;
  updated_by: string;
  updated_at: Date;
}

export async function getTaxSettings(tx: TransactionSql, schoolId: string): Promise<TaxSettings> {
  const [row] = await tx<RawRow[]>`
    SELECT is_enabled, tax_name, rate::text AS rate, erpnext_account_head, registration_number,
           prices_include_tax, updated_by, updated_at
    FROM app.school_tax_settings
    WHERE school_id = ${schoolId}::uuid
  `;
  if (!row) return UNCONFIGURED;
  const exempt = await tx<{ fee_category: string }[]>`
    SELECT fee_category FROM app.school_tax_exempt_categories
    WHERE school_id = ${schoolId}::uuid
    ORDER BY fee_category
  `;
  return {
    configured: true,
    is_enabled: row.is_enabled,
    tax_name: row.tax_name,
    rate: Number(row.rate),
    erpnext_account_head: row.erpnext_account_head,
    registration_number: row.registration_number,
    prices_include_tax: row.prices_include_tax,
    exempt_fee_categories: exempt.map((category) => category.fee_category),
    updated_by: row.updated_by,
    updated_at: row.updated_at.toISOString(),
  };
}

export async function saveTaxSettings(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  body: UpdateTaxSettingsBody,
): Promise<void> {
  const before = await getTaxSettings(tx, schoolId);
  const exempt = [...new Set(body.exempt_fee_categories)].sort();
  await tx`
    INSERT INTO app.school_tax_settings (
      school_id, is_enabled, tax_name, rate, erpnext_account_head, registration_number,
      prices_include_tax, updated_by
    ) VALUES (
      ${schoolId}::uuid, ${body.is_enabled}, ${body.tax_name}, ${body.rate}, ${body.erpnext_account_head},
      ${body.registration_number}, ${body.prices_include_tax}, ${userId}::uuid
    )
    ON CONFLICT (school_id) DO UPDATE SET
      is_enabled = EXCLUDED.is_enabled,
      tax_name = EXCLUDED.tax_name,
      rate = EXCLUDED.rate,
      erpnext_account_head = EXCLUDED.erpnext_account_head,
      registration_number = EXCLUDED.registration_number,
      prices_include_tax = EXCLUDED.prices_include_tax,
      updated_by = EXCLUDED.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `;
  // The exempt categories are replaced as a set.
  await tx`DELETE FROM app.school_tax_exempt_categories WHERE school_id = ${schoolId}::uuid`;
  if (exempt.length > 0) {
    await tx`
      INSERT INTO app.school_tax_exempt_categories (school_id, fee_category)
      SELECT ${schoolId}::uuid, unnest(${exempt}::text[])
    `;
  }
  await emitAuditLog(tx, {
    action: before.configured ? "update" : "insert",
    targetTable: "school_tax_settings",
    targetId: schoolId,
    oldValues: before.configured
      ? { is_enabled: before.is_enabled, rate: before.rate, tax_name: before.tax_name }
      : undefined,
    newValues: {
      is_enabled: body.is_enabled,
      rate: body.rate,
      tax_name: body.tax_name,
      erpnext_account_head: body.erpnext_account_head,
      prices_include_tax: body.prices_include_tax,
      exempt_fee_categories: exempt,
    },
  });
}
