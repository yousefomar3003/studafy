import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";
import { translateErpNextError as translateSharedErpNextError } from "../erpnext-errors";
import { upsertMapping } from "../id-mappings/service";

import type { StorageService } from "../../../lib/storage";
import type { TenantErpNext } from "../client/tenant-client";
import type { JSONValue, TransactionSql } from "postgres";

export type ExpenseDocumentType = "purchase_invoice" | "expense_claim" | "journal_entry";

const ERPNEXT_RESOURCES: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "/api/resource/Purchase%20Invoice",
  expense_claim: "/api/resource/Expense%20Claim",
  journal_entry: "/api/resource/Journal%20Entry",
};

const ERPNEXT_DOCTYPES: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "Purchase Invoice",
  expense_claim: "Expense Claim",
  journal_entry: "Journal Entry",
};

export interface ExpenseRow {
  id: string;
  school_id: string;
  document_type: ExpenseDocumentType;
  category: string;
  vendor: string;
  description: string | null;
  amount: string;
  amount_minor: number;
  currency: string;
  currency_minor_unit: number;
  erpnext_name: string | null;
  erpnext_status: string;
  attachment_url: string | null;
  expense_date: string;
  last_synced_at: Date;
}

export interface ListExpensesParams {
  document_type?: ExpenseDocumentType;
  category?: string;
  date_from?: string;
  date_to?: string;
  limit: number;
  offset: number;
}

export interface CreateExpenseParams {
  document_type: ExpenseDocumentType;
  category: string;
  vendor: string;
  amount: number;
  currency?: string;
  description?: string;
  expense_date?: string;
  attachment_storage_key?: string;
}

export type UpdateExpenseParams = Partial<CreateExpenseParams>;

const CACHE_COLUMNS = `
  ec.id,
  ec.school_id,
  ec.document_type::text AS document_type,
  ec.category,
  ec.vendor,
  ec.description,
  ec.amount_minor,
  ec.erpnext_docname AS erpnext_name,
  ec.erpnext_status,
  ec.attachment_storage_key,
  ec.expense_date::text AS expense_date,
  ec.last_synced_at,
  c.code AS currency,
  c.minor_unit AS currency_minor_unit
`;

function parseCacheRow(row: Record<string, unknown>, presignedUrl?: string | null): ExpenseRow {
  const minorUnit = row.currency_minor_unit as number;
  const minor = BigInt(row.amount_minor as string | number);

  return {
    id: row.id as string,
    school_id: row.school_id as string,
    document_type: row.document_type as ExpenseDocumentType,
    category: row.category as string,
    vendor: row.vendor as string,
    description: row.description as string | null,
    amount: formatMinorUnits(minor, minorUnit),
    amount_minor: Number(minor),
    currency: row.currency as string,
    currency_minor_unit: minorUnit,
    erpnext_name: row.erpnext_name as string | null,
    erpnext_status: row.erpnext_status as string,
    attachment_url: presignedUrl ?? null,
    expense_date: row.expense_date as string,
    last_synced_at: row.last_synced_at as Date,
  };
}

interface ErpNextExpenseDoc {
  name?: string;
  docstatus?: number | null;
  currency?: string | null;
  total_amount?: number | string | null;
  total_claimed_amount?: number | string | null;
}

function statusFromDocstatus(docstatus: number | null | undefined): string {
  if (docstatus === 1) return "submitted";
  if (docstatus === 2) return "cancelled";
  return "draft";
}

function totalFromDoc(doc: ErpNextExpenseDoc): number {
  return Number(doc.total_amount ?? doc.total_claimed_amount ?? 0);
}

/**
 * Expense-shaped view of the shared translation (ST-121 moved the body to ../erpnext-errors so
 * payments could share it). Only the 404 differs between the two callers.
 */
function translateErpNextError(error: unknown): never {
  translateSharedErpNextError(error, {
    notFound: { code: ERROR_CODES.EXPENSE_NOT_FOUND, message: "Expense not found" },
  });
}

function toErpNextPayload(
  documentType: ExpenseDocumentType,
  params: CreateExpenseParams,
  schoolId: string,
): Record<string, unknown> {
  const { category, vendor, amount, currency = "JOD", description, expense_date } = params;
  const postingDate = expense_date ?? new Date().toISOString().slice(0, 10);

  switch (documentType) {
    case "purchase_invoice":
      return {
        supplier: vendor,
        currency,
        posting_date: postingDate,
        custom_school_id: schoolId,
        items: [
          {
            item_name: description ?? `Expense: ${category}`,
            expense_account: category,
            qty: 1,
            rate: amount,
            amount,
          },
        ],
      };

    case "expense_claim":
      return {
        employee: vendor,
        currency,
        total_claimed_amount: amount,
        custom_school_id: schoolId,
        expenses: [
          {
            expense_type: category,
            amount,
            description: description ?? null,
          },
        ],
      };

    case "journal_entry":
      return {
        posting_date: postingDate,
        user_remark: description ?? `Expense: ${category}`,
        custom_school_id: schoolId,
        accounts: [
          {
            account: category,
            debit_in_account_currency: amount,
          },
          {
            account: "Creditors",
            credit_in_account_currency: amount,
          },
        ],
      };
  }
}

async function projectToCache(
  tx: TransactionSql,
  schoolId: string,
  documentType: ExpenseDocumentType,
  doc: ErpNextExpenseDoc,
  params: CreateExpenseParams,
): Promise<ExpenseRow> {
  const erpnextName = doc.name;
  if (!erpnextName) {
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      "ERPNext returned a document with no name",
    );
  }

  const currencyCode = (doc.currency ?? params.currency ?? "JOD").toUpperCase();
  const currency = await getCurrencyByCode(tx, currencyCode);
  if (!currency) {
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      `ERPNext returned an unknown currency: ${currencyCode}`,
    );
  }

  const totalAmount = totalFromDoc(doc) > 0 ? totalFromDoc(doc) : params.amount;
  const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);
  const expenseDate = params.expense_date ?? new Date().toISOString().slice(0, 10);

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.expense_cache (
      school_id, document_type, category, vendor, description,
      currency_id, amount_minor, erpnext_docname, erpnext_status,
      attachment_storage_key, expense_date, erpnext_payload, last_synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${documentType}::text,
      ${params.category},
      ${params.vendor},
      ${params.description ?? null},
      ${currency.id}::uuid,
      ${totalMinor.toString()}::bigint,
      ${erpnextName},
      ${statusFromDocstatus(doc.docstatus)},
      ${params.attachment_storage_key ?? null},
      ${expenseDate}::date,
      ${tx.json(doc as unknown as JSONValue)}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (school_id, erpnext_docname) DO UPDATE
      SET document_type        = EXCLUDED.document_type,
          category             = EXCLUDED.category,
          vendor               = EXCLUDED.vendor,
          description          = EXCLUDED.description,
          currency_id          = EXCLUDED.currency_id,
          amount_minor         = EXCLUDED.amount_minor,
          erpnext_status       = EXCLUDED.erpnext_status,
          attachment_storage_key = EXCLUDED.attachment_storage_key,
          expense_date         = EXCLUDED.expense_date,
          erpnext_payload      = EXCLUDED.erpnext_payload,
          last_synced_at       = EXCLUDED.last_synced_at,
          updated_at           = CURRENT_TIMESTAMP
    RETURNING id
  `;

  await upsertMapping(tx, schoolId, "expense", row!.id as string, erpnextName);

  const [projected] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.expense_cache AS ec
    JOIN app.currencies AS c ON c.id = ec.currency_id
    WHERE ec.school_id = ${schoolId}::uuid AND ec.erpnext_docname = ${erpnextName}
  `;

  return parseCacheRow(projected!);
}

export async function resolveStorageUrl(
  storage: StorageService,
  schoolId: string,
  storageKey: string | null,
): Promise<string | null> {
  if (!storageKey) return null;
  try {
    const { url } = await storage.presign(storageKey, "GET");
    return url;
  } catch {
    return null;
  }
}

export async function listExpenses(
  tx: TransactionSql,
  schoolId: string,
  params: ListExpensesParams,
): Promise<{ rows: ExpenseRow[]; total: number }> {
  const conditions = tx`ec.school_id = ${schoolId}::uuid`;
  const docTypeFilter = params.document_type
    ? tx` AND ec.document_type = ${params.document_type}::text`
    : tx``;
  const categoryFilter = params.category ? tx` AND ec.category = ${params.category}` : tx``;
  const dateFromFilter = params.date_from
    ? tx` AND ec.expense_date >= ${params.date_from}::date`
    : tx``;
  const dateToFilter = params.date_to ? tx` AND ec.expense_date <= ${params.date_to}::date` : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(CACHE_COLUMNS)}
      FROM app.expense_cache AS ec
      JOIN app.currencies AS c ON c.id = ec.currency_id
      WHERE ${conditions}${docTypeFilter}${categoryFilter}${dateFromFilter}${dateToFilter}
      ORDER BY ec.expense_date DESC, ec.last_synced_at DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.expense_cache AS ec
      WHERE ${conditions}${docTypeFilter}${categoryFilter}${dateFromFilter}${dateToFilter}
    `,
  ]);

  return { rows: rows.map((r) => parseCacheRow(r)), total: count?.total ?? 0 };
}

export async function getExpense(
  tx: TransactionSql,
  schoolId: string,
  expenseId: string,
  storage?: StorageService | null,
): Promise<ExpenseRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.expense_cache AS ec
    JOIN app.currencies AS c ON c.id = ec.currency_id
    WHERE ec.school_id = ${schoolId}::uuid
      AND (ec.id = ${expenseId}::uuid OR ec.erpnext_docname = ${expenseId})
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.EXPENSE_NOT_FOUND, "Expense not found");
  }

  const attachmentUrl = await resolveStorageUrl(
    storage!,
    schoolId,
    row.attachment_storage_key as string | null,
  );

  return parseCacheRow(row, attachmentUrl);
}

export async function createExpense(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  params: CreateExpenseParams,
  acceptLanguage?: string,
): Promise<ExpenseRow> {
  const payload = toErpNextPayload(params.document_type, params, schoolId);

  let doc: ErpNextExpenseDoc;
  try {
    const resource = ERPNEXT_RESOURCES[params.document_type];
    const response = await erpnext.post<{ data: ErpNextExpenseDoc }>(resource, payload, {
      acceptLanguage,
    });
    doc = response.data.data;
  } catch (error) {
    translateErpNextError(error);
  }

  const row = await projectToCache(tx, schoolId, params.document_type, doc, params);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "expense_cache",
    targetId: schoolId,
    newValues: {
      erpnext_doctype: ERPNEXT_DOCTYPES[params.document_type],
      erpnext_name: row.erpnext_name,
      category: row.category,
      vendor: row.vendor,
      amount_minor: row.amount_minor,
      currency: row.currency,
    },
  });

  return row;
}

export async function updateExpense(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  expenseId: string,
  params: UpdateExpenseParams,
  acceptLanguage?: string,
): Promise<ExpenseRow> {
  const [before] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.expense_cache AS ec
    JOIN app.currencies AS c ON c.id = ec.currency_id
    WHERE ec.school_id = ${schoolId}::uuid
      AND (ec.id = ${expenseId}::uuid OR ec.erpnext_docname = ${expenseId})
  `;

  if (!before) {
    throw new CodedHttpException(404, ERROR_CODES.EXPENSE_NOT_FOUND, "Expense not found");
  }

  const documentType = before.document_type as ExpenseDocumentType;
  const erpnextName = before.erpnext_name as string;
  const resource = ERPNEXT_RESOURCES[documentType];
  const currencyMinorUnit = before.currency_minor_unit as number;

  const createParams: CreateExpenseParams = {
    document_type: documentType,
    category: params.category ?? (before.category as string),
    vendor: params.vendor ?? (before.vendor as string),
    amount: params.amount ?? Number(before.amount_minor as number) / 10 ** currencyMinorUnit,
    currency: params.currency ?? (before.currency as string),
    description: params.description ?? (before.description as string | undefined),
    expense_date: params.expense_date ?? (before.expense_date as string),
    attachment_storage_key:
      params.attachment_storage_key ?? (before.attachment_storage_key as string | undefined),
  };

  const payload = toErpNextPayload(documentType, createParams, schoolId);

  let doc: ErpNextExpenseDoc;
  try {
    const response = await erpnext.put<{ data: ErpNextExpenseDoc }>(
      `${resource}/${encodeURIComponent(erpnextName)}`,
      payload,
      { acceptLanguage },
    );
    doc = response.data.data;
  } catch (error) {
    translateErpNextError(error);
  }

  const row = await projectToCache(tx, schoolId, documentType, doc, createParams);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "expense_cache",
    targetId: schoolId,
    oldValues: {
      erpnext_name: erpnextName,
      category: before.category as string,
      vendor: before.vendor as string,
      amount_minor: before.amount_minor as number,
      currency: before.currency as string,
    },
    newValues: {
      erpnext_name: row.erpnext_name,
      category: row.category,
      vendor: row.vendor,
      amount_minor: row.amount_minor,
      currency: row.currency,
    },
  });

  return row;
}

export async function confirmAttachment(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  expenseId: string,
  tempKey: string,
): Promise<ExpenseRow> {
  const { assertSchoolOwnedKey } = await import("../../../lib/storage/keys");
  const { buildPermanentKey } = await import("../../../lib/storage/keys");
  const { promoteTempObject } = await import("../../../lib/storage/promote");
  const { assertStorageUploadQuota, recordStorageUpload } =
    await import("../../storage/quota-service");

  assertSchoolOwnedKey(tempKey, schoolId, "temp");

  const [before] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.expense_cache AS ec
    JOIN app.currencies AS c ON c.id = ec.currency_id
    WHERE ec.school_id = ${schoolId}::uuid
      AND (ec.id = ${expenseId}::uuid OR ec.erpnext_docname = ${expenseId})
  `;

  if (!before) {
    throw new CodedHttpException(404, ERROR_CODES.EXPENSE_NOT_FOUND, "Expense not found");
  }

  const objectId = crypto.randomUUID();
  const filename = tempKey.split("/").at(-1) ?? "attachment";
  const permanentKey = buildPermanentKey(schoolId, objectId, filename);
  const promoted = await promoteTempObject(storage, tempKey, permanentKey, {
    onSize: async (sizeBytes) => {
      await assertStorageUploadQuota(tx, sizeBytes);
    },
  });
  await recordStorageUpload(tx, promoted.sizeBytes);

  const erpnextName = before.erpnext_name as string;
  await tx`
    UPDATE app.expense_cache
    SET attachment_storage_key = ${permanentKey},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${erpnextName}
  `;

  const presigned = await storage.presign(permanentKey, "GET");
  const [updated] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.expense_cache AS ec
    JOIN app.currencies AS c ON c.id = ec.currency_id
    WHERE ec.school_id = ${schoolId}::uuid AND ec.erpnext_docname = ${erpnextName}
  `;

  return parseCacheRow(updated!, presigned.url);
}

export async function getMonthlySummary(
  tx: TransactionSql,
  schoolId: string,
  year: number,
  month: number,
  documentType?: ExpenseDocumentType,
): Promise<{
  categories: {
    category: string;
    total_amount: string;
    total_amount_minor: number;
    count: number;
  }[];
  grand_total: string;
  grand_total_minor: number;
}> {
  const docTypeFilter = documentType ? tx` AND ec.document_type = ${documentType}::text` : tx``;

  const rows = await tx<Record<string, unknown>[]>`
    SELECT
      ec.category,
      sum(ec.amount_minor)::bigint AS amount_minor_total,
      count(*)::int AS count,
      c.minor_unit AS currency_minor_unit
    FROM app.expense_cache AS ec
    JOIN app.currencies AS c ON c.id = ec.currency_id
    WHERE ec.school_id = ${schoolId}::uuid
      AND extract(YEAR FROM ec.expense_date) = ${year}
      AND extract(MONTH FROM ec.expense_date) = ${month}
      ${docTypeFilter}
    GROUP BY ec.category, c.minor_unit
    ORDER BY ec.category
  `;

  let grandTotalMinor = 0n;

  const categories = rows.map((r) => {
    const totalMinor = BigInt(r.amount_minor_total as string);
    const minorUnit = r.currency_minor_unit as number;
    grandTotalMinor += totalMinor;
    return {
      category: r.category as string,
      total_amount: formatMinorUnits(totalMinor, minorUnit),
      total_amount_minor: Number(totalMinor),
      count: r.count as number,
    };
  });

  return {
    categories,
    grand_total: formatMinorUnits(grandTotalMinor, 3),
    grand_total_minor: Number(grandTotalMinor),
  };
}
