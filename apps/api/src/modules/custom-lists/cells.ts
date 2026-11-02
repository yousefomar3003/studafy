/**
 * Custom list cells as typed rows (000182): one app.custom_list_values row per filled cell -- per
 * chosen option for multi_choice -- in the column its type uses, or, for a sensitive column, sealed
 * (AES-256-GCM, ADR-019) with the row and column as additional authenticated data. Values are
 * validated by the same normalizeRecordValue the school record fields use, so a list cell and a
 * record answer accept exactly the same input.
 */

import { randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import {
  RecordKeyUnavailableError,
  RecordSealBrokenError,
  normalizeRecordValue,
  openRecordValue,
  sealRecordValue,
} from "@studafy/records";

import { CodedHttpException } from "../../coded-http-exception";

import type { ColumnRow } from "./list-service";
import type { RecordValue, RecordValueError } from "@studafy/records";
import type { TransactionSql } from "postgres";

/** Rows per multi-row INSERT: 13 parameters each stays far under PostgreSQL's 65,535. */
const INSERT_CHUNK = 2_000;

export interface ValueInsert {
  id: string;
  school_id: string;
  list_id: string;
  row_id: string;
  column_id: string;
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_bool: boolean | null;
  option_id: string | null;
  value_ciphertext: Uint8Array | null;
  value_key_id: string | null;
  value_mask: string | null;
  updated_by: string | null;
}

interface StoredValue {
  row_id: string;
  column_id: string;
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_bool: boolean | null;
  option_id: string | null;
  value_ciphertext: Uint8Array | null;
  value_key_id: string | null;
  value_mask: string | null;
}

export interface Cell {
  column_id: string;
  value: RecordValue | null;
  masked: boolean;
  mask: string | null;
}

export interface CellScope {
  schoolId: string;
  listId: string;
  userId: string | null;
}

export type NormalizedCell =
  { ok: true; value: RecordValue | null } | { ok: false; error: RecordValueError };

export function normalizeCell(column: ColumnRow, raw: unknown): NormalizedCell {
  return normalizeRecordValue({ field_type: column.field_type, options: column.options }, raw);
}

/** Names the column, never echoes the value (as RECORD_VALUE_INVALID does for records). */
export function cellInvalid(column: ColumnRow, error: string): never {
  throw new CodedHttpException(
    422,
    ERROR_CODES.RECORD_VALUE_INVALID,
    `${column.label_en}: ${error}`,
  );
}

export function sealContext(schoolId: string, rowId: string, columnId: string) {
  return { schoolId, subjectKind: "custom_list_row" as const, subjectId: rowId, fieldId: columnId };
}

/** The value rows one normalized, non-null cell is stored as. */
export function valueRows(
  scope: CellScope,
  keyring: Parameters<typeof sealRecordValue>[0],
  rowId: string,
  column: ColumnRow,
  value: RecordValue,
): ValueInsert[] {
  const base: ValueInsert = {
    id: randomUUID(),
    school_id: scope.schoolId,
    list_id: scope.listId,
    row_id: rowId,
    column_id: column.id,
    value_text: null,
    value_number: null,
    value_date: null,
    value_bool: null,
    option_id: null,
    value_ciphertext: null,
    value_key_id: null,
    value_mask: null,
    updated_by: scope.userId,
  };
  if (column.sensitivity === "sensitive") {
    let sealed;
    try {
      sealed = sealRecordValue(
        keyring,
        sealContext(scope.schoolId, rowId, column.id),
        column.field_type,
        value,
      );
    } catch (error) {
      if (error instanceof RecordKeyUnavailableError) keyUnavailable();
      throw error;
    }
    return [
      {
        ...base,
        value_ciphertext: sealed.ciphertext,
        value_key_id: sealed.keyId,
        value_mask: sealed.mask,
      },
    ];
  }
  const optionId = (choice: string): string => {
    const option = column.options.find((candidate) => candidate.value === choice);
    if (!option) cellInvalid(column, "RECORD_VALUE_INVALID_CHOICE");
    return option.id;
  };
  switch (column.field_type) {
    case "number":
      return [{ ...base, value_number: String(value) }];
    case "date":
      return [{ ...base, value_date: String(value) }];
    case "yes_no":
      return [{ ...base, value_bool: value === true }];
    case "single_choice":
      return [{ ...base, option_id: optionId(String(value)) }];
    case "multi_choice":
      return (value as string[]).map((choice, index) => ({
        ...base,
        id: index === 0 ? base.id : randomUUID(),
        option_id: optionId(choice),
      }));
    default:
      return [{ ...base, value_text: String(value) }];
  }
}

function keyUnavailable(): never {
  throw new CodedHttpException(
    503,
    ERROR_CODES.RECORD_KEY_UNAVAILABLE,
    "The encryption key for this value is not available",
  );
}

export async function insertValues(
  tx: TransactionSql,
  rows: readonly ValueInsert[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await tx`
      INSERT INTO app.custom_list_values ${tx(
        chunk as ValueInsert[],
        "id",
        "school_id",
        "list_id",
        "row_id",
        "column_id",
        "value_text",
        "value_number",
        "value_date",
        "value_bool",
        "option_id",
        "value_ciphertext",
        "value_key_id",
        "value_mask",
        "updated_by",
      )}
    `;
  }
}

/** Remove a cell's stored rows (every chosen option of a multi_choice cell). */
export async function clearCells(
  tx: TransactionSql,
  schoolId: string,
  rowId: string,
  columnIds: readonly string[],
): Promise<void> {
  if (columnIds.length === 0) return;
  await tx`
    DELETE FROM app.custom_list_values
    WHERE school_id = ${schoolId}::uuid AND row_id = ${rowId}::uuid
      AND column_id = ANY(${columnIds as string[]}::uuid[])
  `;
}

/**
 * The cells of these rows for these (non-archived) columns, keyed by row, in column order. A
 * sensitive cell comes back as its mask only.
 */
export async function loadCells(
  tx: TransactionSql,
  schoolId: string,
  rowIds: readonly string[],
  columns: readonly ColumnRow[],
): Promise<Map<string, Cell[]>> {
  const cells = new Map<string, Cell[]>();
  if (rowIds.length === 0 || columns.length === 0) return cells;
  const stored = await tx<StoredValue[]>`
    SELECT row_id, column_id, value_text, value_number::text AS value_number,
           to_char(value_date, 'YYYY-MM-DD') AS value_date, value_bool, option_id,
           value_ciphertext, value_key_id, value_mask
    FROM app.custom_list_values
    WHERE school_id = ${schoolId}::uuid
      AND row_id = ANY(${rowIds as string[]}::uuid[])
      AND column_id = ANY(${columns.map((column) => column.id)}::uuid[])
  `;
  const byCell = new Map<string, StoredValue[]>();
  for (const value of stored) {
    const key = `${value.row_id}|${value.column_id}`;
    const list = byCell.get(key) ?? [];
    list.push(value);
    byCell.set(key, list);
  }
  for (const rowId of rowIds) {
    const rowCells: Cell[] = [];
    for (const column of columns) {
      const values = byCell.get(`${rowId}|${column.id}`);
      if (!values || values.length === 0) continue;
      rowCells.push(toCell(column, values));
    }
    cells.set(rowId, rowCells);
  }
  return cells;
}

function toCell(column: ColumnRow, values: readonly StoredValue[]): Cell {
  const first = values[0]!;
  if (first.value_ciphertext !== null) {
    return { column_id: column.id, value: null, masked: true, mask: first.value_mask };
  }
  const optionValue = (id: string | null) =>
    column.options.find((option) => option.id === id)?.value ?? null;
  let value: RecordValue | null;
  switch (column.field_type) {
    case "number":
      value = first.value_number === null ? null : Number(first.value_number);
      break;
    case "date":
      value = first.value_date;
      break;
    case "yes_no":
      value = first.value_bool;
      break;
    case "single_choice":
      value = optionValue(first.option_id);
      break;
    case "multi_choice": {
      // In the column's own option order, as the form lists them.
      const chosen = new Set(values.map((stored) => stored.option_id));
      value = column.options
        .filter((option) => chosen.has(option.id))
        .map((option) => option.value);
      break;
    }
    default:
      value = first.value_text;
  }
  return { column_id: column.id, value, masked: false, mask: null };
}

/** Open one sealed cell for an audited reveal, or a DSR export. */
export function openCell(
  keyring: Parameters<typeof openRecordValue>[0],
  schoolId: string,
  rowId: string,
  columnId: string,
  sealed: { value_ciphertext: Uint8Array; value_key_id: string; value_mask: string },
): RecordValue {
  try {
    return openRecordValue(keyring, sealContext(schoolId, rowId, columnId), {
      ciphertext: sealed.value_ciphertext,
      keyId: sealed.value_key_id,
      mask: sealed.value_mask,
    }).unwrap();
  } catch (error) {
    if (error instanceof RecordKeyUnavailableError) keyUnavailable();
    if (error instanceof RecordSealBrokenError) {
      throw new CodedHttpException(500, ERROR_CODES.INTERNAL_ERROR, "Stored value is unreadable");
    }
    throw error;
  }
}
