/**
 * "Create a custom list from this sheet" (docs/modules/custom-lists.md "Import"). A CSV Studafy
 * does not recognise becomes a new list: its first line names the columns, each column's type is
 * guessed from its own cells (guessColumn, the same guess the student import makes, run here and
 * nowhere else), and staff confirm names, types and sensitivity.
 *
 * Rows can be linked by one column of the school's own keys -- a Studafy member code, an admission
 * number, an employee number or a class code -- matched exactly: the whole value, surrounding
 * spaces and letter case aside, never partially and never by name, email, phone, ID number or any
 * other cell. Two subjects with the same key link neither. The preview lists every row with what it
 * would link to or why it would not, and hands out a token over all of that; nothing is written
 * until an apply presents the same token, so what is confirmed is exactly what was previewed.
 */

import { createHash, randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import { maskRecordValue, normalizeRecordValue } from "@studafy/records";
import { guessColumn, parseCsv } from "@studafy/student-import";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { insertValues, valueRows } from "./cells";
import { MAX_COLUMNS_PER_LIST, MAX_OPTIONS_PER_COLUMN, MAX_ROWS_PER_LIST } from "./limits";
import { assertRowRoom, createList, invalid, loadColumns } from "./list-service";
import { linkNames } from "./row-service";

import type { ValueInsert } from "./cells";
import type { CustomListActor } from "./list-service";
import type {
  CustomListImportInput,
  CustomListImportPreviewDto,
  CustomListImportResultDto,
  CustomListLinkKind,
  CustomListLinks,
} from "./schemas";
import type {
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordKeyring,
  RecordValue,
} from "@studafy/records";
import type { TransactionSql } from "postgres";

type ColumnType = Exclude<RecordFieldType, "document">;
type RowStatus = CustomListImportPreviewDto["rows"][number]["status"];
type MissReason = "NO_MATCH" | "AMBIGUOUS";

const INVALID_LINES_SHOWN = 20;
const SAMPLE_SIZE = 3;

interface PlannedColumn {
  index: number;
  header: string;
  include: boolean;
  label_en: string;
  label_ar: string;
  field_type: ColumnType;
  guessed_type: ColumnType;
  sensitivity: RecordFieldSensitivity;
  suggested_sensitive: boolean;
  options: RecordFieldOption[];
  /** Per data row: the normalized value, null for an empty cell, undefined for an invalid one. */
  values: (RecordValue | null | undefined)[];
  invalid_lines: number[];
  sample: string[];
}

interface PlannedRow {
  line: number;
  key: string | null;
  status: RowStatus;
  reason: MissReason | null;
  link: { kind: CustomListLinkKind; id: string } | null;
}

interface ImportPlan {
  headerLine: number;
  columns: PlannedColumn[];
  rows: PlannedRow[];
  links: CustomListLinks;
  token: string;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function readSheet(csv: string): {
  headerLine: number;
  headers: string[];
  rows: { line: number; cells: string[] }[];
} {
  const records = parseCsv(csv);
  if (records.length < 2) invalid("The sheet needs a header line and at least one row");
  const header = records[0]!;
  if (header.cells.length > 256) invalid("A sheet can have at most 256 columns");
  const seen = new Map<string, number>();
  const headers = header.cells.map((cell, index) => {
    const base = cell.trim().slice(0, 190) || `Column ${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const rows = records.slice(1).map((record) => ({ line: record.line, cells: record.cells }));
  if (rows.length > MAX_ROWS_PER_LIST) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CUSTOM_LIST_LIMIT_REACHED,
      `A list holds at most ${MAX_ROWS_PER_LIST} rows; this sheet has ${rows.length}`,
    );
  }
  return { headerLine: header.line, headers, rows };
}

function distinctOptions(values: readonly string[], split: boolean): RecordFieldOption[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    for (const part of split ? value.split(/[;|]/) : [value]) {
      const trimmed = part.trim().slice(0, 100);
      if (trimmed && !byKey.has(trimmed.toLowerCase())) byKey.set(trimmed.toLowerCase(), trimmed);
    }
  }
  if (byKey.size > MAX_OPTIONS_PER_COLUMN) {
    invalid(`A choice column has at most ${MAX_OPTIONS_PER_COLUMN} choices`);
  }
  return [...byKey.values()].map((value) => ({ value, label_en: value, label_ar: value }));
}

function planColumns(
  headers: readonly string[],
  rows: readonly { line: number; cells: string[] }[],
  input: CustomListImportInput,
): PlannedColumn[] {
  const overrides = new Map((input.columns ?? []).map((column) => [column.index, column]));
  for (const index of overrides.keys()) {
    if (index >= headers.length) invalid(`The sheet has no column ${index + 1}`);
  }
  return headers.map((header, index) => {
    const override = overrides.get(index);
    const cells = rows.map((row) => (row.cells[index] ?? "").trim());
    const guess = guessColumn(header, cells);
    const fieldType = override?.field_type ?? guess.field_type;
    const options =
      fieldType === guess.field_type
        ? guess.options
        : fieldType === "single_choice" || fieldType === "multi_choice"
          ? distinctOptions(
              cells.filter((cell) => cell !== ""),
              fieldType === "multi_choice",
            )
          : [];
    const sensitivity =
      override?.sensitivity ?? (guess.sensitive_reason ? "sensitive" : "standard");
    const label = header.slice(0, 200);
    const planned: PlannedColumn = {
      index,
      header,
      // Past the column cap, columns start left out; staff choose which to keep.
      include: override?.include ?? index < MAX_COLUMNS_PER_LIST,
      label_en: override?.label_en ?? label,
      label_ar: override?.label_ar ?? label,
      field_type: fieldType,
      guessed_type: guess.field_type,
      sensitivity,
      suggested_sensitive: guess.sensitive_reason !== null,
      options,
      values: [],
      invalid_lines: [],
      sample: [],
    };
    for (const [rowIndex, cell] of cells.entries()) {
      const normalized = normalizeRecordValue({ field_type: fieldType, options }, cell);
      if (!normalized.ok) {
        planned.values.push(undefined);
        planned.invalid_lines.push(rows[rowIndex]!.line);
        continue;
      }
      planned.values.push(normalized.value);
      if (normalized.value !== null && planned.sample.length < SAMPLE_SIZE) {
        // A sensitive column's sample is its mask: the preview never shows what the column hides.
        planned.sample.push(
          sensitivity === "sensitive"
            ? maskRecordValue(fieldType, normalized.value)
            : Array.isArray(normalized.value)
              ? normalized.value.join("; ")
              : String(normalized.value),
        );
      }
    }
    return planned;
  });
}

// ---------------------------------------------------------------------------
// Links by school-issued key, exact match only
// ---------------------------------------------------------------------------

type Matches = Map<string, { kind: CustomListLinkKind; id: string }[]>;

/** Every subject each key names, keyed by the key as normalized for that kind of key. */
async function resolveKeys(
  tx: TransactionSql,
  schoolId: string,
  key: NonNullable<CustomListImportInput["link"]>["key"],
  keys: readonly string[],
): Promise<Matches> {
  const matches: Matches = new Map();
  const add = (value: string, match: { kind: CustomListLinkKind; id: string }) => {
    const list = matches.get(value) ?? [];
    if (!list.some((existing) => existing.id === match.id)) list.push(match);
    matches.set(value, list);
  };
  if (keys.length === 0) return matches;
  switch (key) {
    case "admission_number": {
      const rows = await tx<{ id: string; key: string }[]>`
        SELECT id, normalized_admission_number AS key FROM app.students
        WHERE school_id = ${schoolId}::uuid
          AND normalized_admission_number = ANY(${keys as string[]}::text[])
      `;
      for (const row of rows) add(row.key, { kind: "student", id: row.id });
      break;
    }
    case "employee_number": {
      const rows = await tx<{ id: string; key: string }[]>`
        SELECT user_id AS id, normalized_employee_number AS key FROM app.teachers
        WHERE school_id = ${schoolId}::uuid
          AND normalized_employee_number = ANY(${keys as string[]}::text[])
      `;
      for (const row of rows) add(row.key, { kind: "staff", id: row.id });
      break;
    }
    case "class_code": {
      const rows = await tx<{ id: string; key: string }[]>`
        SELECT id, lower(btrim(code)) AS key FROM app.classes
        WHERE school_id = ${schoolId}::uuid AND lower(btrim(code)) = ANY(${keys as string[]}::text[])
      `;
      for (const row of rows) add(row.key, { kind: "class", id: row.id });
      break;
    }
    case "member_id": {
      // STU- is a student (through the student profile on that account), TCH- a member of staff,
      // PAR- a parent (000140).
      const rows = await tx<
        { kind: string; user_id: string; student_id: string | null; key: string }[]
      >`
        SELECT mc.kind, mc.user_id, s.id AS student_id, lower(mc.code) AS key
        FROM app.member_codes AS mc
        LEFT JOIN app.students AS s ON s.user_id = mc.user_id AND s.school_id = mc.school_id
        WHERE mc.school_id = ${schoolId}::uuid AND lower(mc.code) = ANY(${keys as string[]}::text[])
      `;
      for (const row of rows) {
        if (row.kind === "STU") {
          if (row.student_id) add(row.key, { kind: "student", id: row.student_id });
        } else {
          add(row.key, { kind: row.kind === "TCH" ? "staff" : "parent", id: row.user_id });
        }
      }
      break;
    }
  }
  return matches;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

async function planRows(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly { line: number; cells: string[] }[],
  headers: readonly string[],
  input: CustomListImportInput,
): Promise<PlannedRow[]> {
  const link = input.link ?? null;
  if (!link) {
    return rows.map((row) => ({
      line: row.line,
      key: null,
      status: "not_linked",
      reason: null,
      link: null,
    }));
  }
  if (link.column_index >= headers.length)
    invalid(`The sheet has no column ${link.column_index + 1}`);
  const keyOf = (row: { cells: string[] }) => (row.cells[link.column_index] ?? "").trim();
  const keys = [
    ...new Set(
      rows
        .map(keyOf)
        .filter((key) => key !== "")
        .map(normalizeKey),
    ),
  ];
  const matches = await resolveKeys(tx, schoolId, link.key, keys);
  const skip = input.skip_unmatched === true;
  return rows.map((row) => {
    const key = keyOf(row);
    if (key === "") {
      return {
        line: row.line,
        key: null,
        status: skip ? "skipped" : "no_key",
        reason: null,
        link: null,
      };
    }
    const found = matches.get(normalizeKey(key)) ?? [];
    if (found.length === 1) {
      return { line: row.line, key, status: "linked", reason: null, link: found[0]! };
    }
    return {
      line: row.line,
      key,
      status: skip ? "skipped" : "unmatched",
      reason: found.length === 0 ? "NO_MATCH" : "AMBIGUOUS",
      link: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Plan, preview, apply
// ---------------------------------------------------------------------------

async function planImport(
  tx: TransactionSql,
  actor: CustomListActor,
  input: CustomListImportInput,
): Promise<ImportPlan> {
  const sheet = readSheet(input.csv);
  const columns = planColumns(sheet.headers, sheet.rows, input);
  const rows = await planRows(tx, actor.schoolId, sheet.rows, sheet.headers, input);
  const links: CustomListLinks = { student: false, parent: false, staff: false, class: false };
  for (const row of rows) if (row.link) links[row.link.kind] = true;

  // Over everything an apply depends on -- the file, every choice, every outcome -- and the caller,
  // so a token is good for this caller's exact preview only.
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        school: actor.schoolId,
        user: actor.userId,
        csv: createHash("sha256").update(input.csv).digest("hex"),
        list: input.list,
        skip: input.skip_unmatched === true,
        link: input.link ?? null,
        columns: columns.map((column) => [
          column.index,
          column.include,
          column.label_en,
          column.label_ar,
          column.field_type,
          column.sensitivity,
          column.options,
        ]),
        rows: rows.map((row) => [
          row.line,
          row.status,
          row.link?.kind ?? null,
          row.link?.id ?? null,
        ]),
      }),
    )
    .digest("hex");
  return { headerLine: sheet.headerLine, columns, rows, links, token };
}

export async function previewImport(
  tx: TransactionSql,
  actor: CustomListActor,
  input: CustomListImportInput,
): Promise<CustomListImportPreviewDto> {
  const plan = await planImport(tx, actor, input);
  const names = await linkNames(
    tx,
    actor.schoolId,
    plan.rows.flatMap((row) =>
      row.link
        ? [
            {
              link_kind: row.link.kind,
              student_id: row.link.kind === "student" ? row.link.id : null,
              user_id: row.link.kind === "parent" || row.link.kind === "staff" ? row.link.id : null,
              class_id: row.link.kind === "class" ? row.link.id : null,
            },
          ]
        : [],
    ),
  );
  const included = plan.columns.filter((column) => column.include);
  return {
    header_line: plan.headerLine,
    row_count: plan.rows.length,
    columns: plan.columns.map((column) => ({
      index: column.index,
      header: column.header,
      include: column.include,
      label_en: column.label_en,
      label_ar: column.label_ar,
      field_type: column.field_type,
      guessed_type: column.guessed_type,
      sensitivity: column.sensitivity,
      suggested_sensitive: column.suggested_sensitive,
      options: column.options,
      sample: column.sample,
      invalid_count: column.invalid_lines.length,
      invalid_lines: column.invalid_lines.slice(0, INVALID_LINES_SHOWN),
    })),
    rows: plan.rows.map((row) => ({
      line: row.line,
      key: row.key,
      status: row.status,
      reason: row.reason,
      link: row.link ? { ...row.link, name: names.get(row.link.id) ?? null } : null,
    })),
    totals: {
      rows: plan.rows.length,
      linked: plan.rows.filter((row) => row.status === "linked").length,
      unmatched: plan.rows.filter((row) => row.status === "unmatched" || row.status === "no_key")
        .length,
      skipped: plan.rows.filter((row) => row.status === "skipped").length,
      invalid_cells: included.reduce((sum, column) => sum + column.invalid_lines.length, 0),
    },
    links: plan.links,
    preview_token: plan.token,
  };
}

export async function applyImport(
  tx: TransactionSql,
  actor: CustomListActor,
  keyring: RecordKeyring,
  input: CustomListImportInput & { preview_token: string },
): Promise<CustomListImportResultDto> {
  const plan = await planImport(tx, actor, input);
  if (plan.token !== input.preview_token) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CUSTOM_LIST_PREVIEW_STALE,
      "Something changed since the preview; preview again before confirming",
    );
  }
  const included = plan.columns.filter((column) => column.include);
  if (included.length === 0) invalid("Keep at least one column");
  if (included.length > MAX_COLUMNS_PER_LIST) {
    invalid(`A list has at most ${MAX_COLUMNS_PER_LIST} columns`);
  }
  const written = plan.rows
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => row.status !== "skipped");

  const listId = await createList(tx, actor, {
    ...input.list,
    links: plan.links,
    columns: included.map((column) => ({
      field_type: column.field_type,
      label_en: column.label_en,
      label_ar: column.label_ar,
      sensitivity: column.sensitivity,
      options: column.options,
    })),
  });
  // createList took the school's lock; the new rows must fit the school's cap.
  await assertRowRoom(tx, actor.schoolId, null, written.length);
  const stored = (await loadColumns(tx, actor.schoolId, [listId])).sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  const rowInserts = written.map(({ row }) => ({
    id: randomUUID(),
    school_id: actor.schoolId,
    list_id: listId,
    link_kind: row.link?.kind ?? null,
    student_id: row.link?.kind === "student" ? row.link.id : null,
    user_id: row.link?.kind === "parent" || row.link?.kind === "staff" ? row.link.id : null,
    class_id: row.link?.kind === "class" ? row.link.id : null,
    created_by: actor.userId,
    updated_by: actor.userId,
  }));
  for (let i = 0; i < rowInserts.length; i += 2_000) {
    await tx`
      INSERT INTO app.custom_list_rows ${tx(
        rowInserts.slice(i, i + 2_000),
        "id",
        "school_id",
        "list_id",
        "link_kind",
        "student_id",
        "user_id",
        "class_id",
        "created_by",
        "updated_by",
      )}
    `;
  }

  const scope = { schoolId: actor.schoolId, listId, userId: actor.userId };
  const values: ValueInsert[] = [];
  let leftEmpty = 0;
  for (const [index, { position }] of written.entries()) {
    const rowId = rowInserts[index]!.id;
    for (const [columnIndex, column] of included.entries()) {
      const value = column.values[position];
      if (value === undefined) {
        leftEmpty += 1;
        continue;
      }
      if (value === null) continue;
      values.push(...valueRows(scope, keyring, rowId, stored[columnIndex]!, value));
    }
  }
  await insertValues(tx, values);

  const linked = written.filter(({ row }) => row.link !== null).length;
  // One audit row for the whole import: what was written and how, never a cell.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "custom_list_rows",
    targetId: listId,
    newValues: {
      import: true,
      file_name: input.file_name ?? null,
      link_key: input.link?.key ?? null,
      rows_created: written.length,
      rows_linked: linked,
      rows_skipped: plan.rows.length - written.length,
      cells_left_empty: leftEmpty,
    },
  });
  return {
    list_id: listId,
    rows_created: written.length,
    rows_linked: linked,
    cells_left_empty: leftEmpty,
  };
}
