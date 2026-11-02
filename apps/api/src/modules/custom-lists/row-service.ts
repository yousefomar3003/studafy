/**
 * Custom list rows (docs/modules/custom-lists.md): the table view (search, one filter, sort,
 * pages), add / edit / delete, the audited reveal of a sensitive cell, CSV export without sensitive
 * columns, and the rows linked to one student, parent, member of staff or class.
 *
 * Everything runs under the caller's RLS scope, so a list outside their audience -- and every row
 * and value in it -- is not found. A linked person's or class's name is read under the same scope:
 * someone the caller cannot see is shown as a link with no name, never resolved behind their back.
 */

import { ERROR_CODES, SCHOOL_STAFF_ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  cellInvalid,
  clearCells,
  insertValues,
  loadCells,
  normalizeCell,
  openCell,
  valueRows,
} from "./cells";
import { MAX_LINK_CANDIDATES, MAX_LINKED_ROWS_PER_LIST } from "./limits";
import {
  allowsLink,
  assertRowRoom,
  columnDto,
  findList,
  invalid,
  loadColumns,
  lockSchoolLists,
  notFound,
} from "./list-service";

import type { Cell, CellScope, ValueInsert } from "./cells";
import type { ColumnRow, CustomListActor, ListRow } from "./list-service";
import type {
  CreateCustomListRowInput,
  CustomListLinkCandidatesDto,
  CustomListLinkKind,
  CustomListLinkedDto,
  CustomListRowDto,
  CustomListRowPageDto,
  CustomListRowsQuery,
  LinkCandidatesQuery,
  UpdateCustomListRowInput,
} from "./schemas";
import type { RecordKeyring, RecordValue } from "@studafy/records";
import type { PendingQuery, Row, TransactionSql } from "postgres";

type Fragment = PendingQuery<Row[]>;

interface StoredRow {
  id: string;
  list_id: string;
  link_kind: CustomListLinkKind | null;
  student_id: string | null;
  user_id: string | null;
  class_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RowLinkInput {
  kind: CustomListLinkKind;
  id: string;
}

const ROW_COLUMNS = (tx: TransactionSql) => tx`
  r.id, r.list_id, r.link_kind::text AS link_kind, r.student_id, r.user_id, r.class_id,
  r.created_at, r.updated_at
`;

function linkTargetId(row: StoredRow): string | null {
  return row.student_id ?? row.user_id ?? row.class_id;
}

function linkInvalid(message: string): never {
  throw new CodedHttpException(422, ERROR_CODES.CUSTOM_LIST_LINK_INVALID, message);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * The display name of every linked subject, read under the caller's scope: a student a teacher
 * does not teach comes back without a name rather than being looked up with wider rights.
 */
export async function linkNames(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly {
    link_kind: CustomListLinkKind | null;
    student_id: string | null;
    user_id: string | null;
    class_id: string | null;
  }[],
): Promise<Map<string, string>> {
  const students = [...new Set(rows.flatMap((row) => (row.student_id ? [row.student_id] : [])))];
  const users = [...new Set(rows.flatMap((row) => (row.user_id ? [row.user_id] : [])))];
  const classes = [...new Set(rows.flatMap((row) => (row.class_id ? [row.class_id] : [])))];
  const names = new Map<string, string>();
  if (students.length > 0) {
    const found = await tx<{ id: string; name: string }[]>`
      SELECT id, concat_ws(' ', coalesce(nullif(preferred_name, ''), first_name), last_name) AS name
      FROM app.students
      WHERE school_id = ${schoolId}::uuid AND id = ANY(${students}::uuid[])
    `;
    for (const row of found) names.set(row.id, row.name);
  }
  if (users.length > 0) {
    const found = await tx<{ id: string; name: string }[]>`
      SELECT id, display_name AS name FROM app.users
      WHERE school_id = ${schoolId}::uuid AND id = ANY(${users}::uuid[])
    `;
    for (const row of found) names.set(row.id, row.name);
  }
  if (classes.length > 0) {
    const found = await tx<{ id: string; name: string }[]>`
      SELECT id, code AS name FROM app.classes
      WHERE school_id = ${schoolId}::uuid AND id = ANY(${classes}::uuid[])
    `;
    for (const row of found) names.set(row.id, row.name);
  }
  return names;
}

/**
 * A link staff chose by hand: the list must allow the kind, and the person or class must exist and
 * be visible to the caller -- a parent holding PARENT, a member of staff holding a staff role.
 */
export async function assertLinkTarget(
  tx: TransactionSql,
  schoolId: string,
  list: ListRow,
  link: RowLinkInput,
): Promise<void> {
  if (!allowsLink(list, link.kind)) linkInvalid(`This list does not link rows to a ${link.kind}`);
  let found: { found: boolean }[];
  switch (link.kind) {
    case "student":
      found = await tx`
        SELECT EXISTS (
          SELECT 1 FROM app.students WHERE school_id = ${schoolId}::uuid AND id = ${link.id}::uuid
        ) AS found
      `;
      break;
    case "class":
      found = await tx`
        SELECT EXISTS (
          SELECT 1 FROM app.classes WHERE school_id = ${schoolId}::uuid AND id = ${link.id}::uuid
        ) AS found
      `;
      break;
    default: {
      const roles = link.kind === "parent" ? ["PARENT"] : [...SCHOOL_STAFF_ROLES];
      found = await tx`
        SELECT EXISTS (
          SELECT 1 FROM app.user_roles AS ur
          JOIN app.users AS u ON u.id = ur.user_id AND u.school_id = ur.school_id
          WHERE ur.school_id = ${schoolId}::uuid AND ur.user_id = ${link.id}::uuid
            AND ur.role::text = ANY(${roles}::text[])
        ) AS found
      `;
    }
  }
  if (!found[0]?.found) linkInvalid(`That ${link.kind} was not found`);
}

/**
 * Who or what a row may be linked to, for the picker staff choose from: only subjects of a kind
 * the list allows, holding the matching role, and visible to the caller under their own RLS scope.
 * A choice made by a person, by name or by the school's own key -- never an automatic match.
 */
export async function linkCandidates(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  query: LinkCandidatesQuery,
): Promise<CustomListLinkCandidatesDto> {
  const list = await findList(tx, actor.schoolId, listId);
  if (!allowsLink(list, query.kind)) {
    linkInvalid(`This list does not link rows to a ${query.kind}`);
  }
  const pattern = likePattern(query.q);
  let candidates: { id: string; name: string; detail: string | null }[];
  switch (query.kind) {
    case "student":
      candidates = await tx`
        SELECT s.id,
               concat_ws(' ', coalesce(nullif(s.preferred_name, ''), s.first_name), s.last_name)
                 AS name,
               s.admission_number AS detail
        FROM app.students AS s
        WHERE s.school_id = ${actor.schoolId}::uuid
          AND (
            concat_ws(' ', s.first_name, s.middle_name, s.last_name, s.preferred_name)
              ILIKE ${pattern}
            OR s.admission_number ILIKE ${pattern}
          )
        ORDER BY lower(s.last_name), lower(s.first_name), s.id
        LIMIT ${MAX_LINK_CANDIDATES}
      `;
      break;
    case "class":
      candidates = await tx`
        SELECT c.id, c.code AS name, co.name AS detail
        FROM app.classes AS c
        LEFT JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
        WHERE c.school_id = ${actor.schoolId}::uuid
          AND (c.code ILIKE ${pattern} OR co.name ILIKE ${pattern})
        ORDER BY lower(c.code), c.id
        LIMIT ${MAX_LINK_CANDIDATES}
      `;
      break;
    default: {
      const roles = query.kind === "parent" ? ["PARENT"] : [...SCHOOL_STAFF_ROLES];
      const codeKind = query.kind === "parent" ? "PAR" : "TCH";
      candidates = await tx`
        SELECT u.id, u.display_name AS name,
               coalesce(t.employee_number, mc.code) AS detail
        FROM app.users AS u
        LEFT JOIN app.teachers AS t ON t.user_id = u.id AND t.school_id = u.school_id
        LEFT JOIN app.member_codes AS mc
          ON mc.user_id = u.id AND mc.school_id = u.school_id AND mc.kind = ${codeKind}
        WHERE u.school_id = ${actor.schoolId}::uuid
          AND EXISTS (
            SELECT 1 FROM app.user_roles AS ur
            WHERE ur.school_id = u.school_id AND ur.user_id = u.id
              AND ur.role::text = ANY(${roles}::text[])
          )
          AND (
            u.display_name ILIKE ${pattern}
            OR mc.code ILIKE ${pattern}
            OR t.employee_number ILIKE ${pattern}
          )
        ORDER BY lower(u.display_name), u.id
        LIMIT ${MAX_LINK_CANDIDATES}
      `;
    }
  }
  return { candidates };
}

function linkColumns(link: RowLinkInput | null): {
  link_kind: CustomListLinkKind | null;
  student_id: string | null;
  user_id: string | null;
  class_id: string | null;
} {
  return {
    link_kind: link?.kind ?? null,
    student_id: link?.kind === "student" ? link.id : null,
    user_id: link?.kind === "parent" || link?.kind === "staff" ? link.id : null,
    class_id: link?.kind === "class" ? link.id : null,
  };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function rowDto(
  row: StoredRow,
  cells: readonly Cell[],
  names: Map<string, string>,
): CustomListRowDto {
  const target = linkTargetId(row);
  return {
    id: row.id,
    link:
      row.link_kind && target
        ? { kind: row.link_kind, id: target, name: names.get(target) ?? null }
        : null,
    cells: [...cells],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function hydrate(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly StoredRow[],
  columns: readonly ColumnRow[],
): Promise<CustomListRowDto[]> {
  const active = columns.filter((column) => column.archived_at === null);
  const cells = await loadCells(
    tx,
    schoolId,
    rows.map((row) => row.id),
    active,
  );
  const names = await linkNames(tx, schoolId, rows);
  return rows.map((row) => rowDto(row, cells.get(row.id) ?? [], names));
}

async function findRow(
  tx: TransactionSql,
  schoolId: string,
  listId: string,
  rowId: string,
  options: { forUpdate?: boolean } = {},
): Promise<StoredRow> {
  const [row] = await tx<StoredRow[]>`
    SELECT ${ROW_COLUMNS(tx)}
    FROM app.custom_list_rows AS r
    WHERE r.school_id = ${schoolId}::uuid AND r.list_id = ${listId}::uuid AND r.id = ${rowId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE` : tx``}
  `;
  return row ?? notFound("row");
}

// ---------------------------------------------------------------------------
// The table: search, filter, sort, pages
// ---------------------------------------------------------------------------

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The linked subject's name, for search and sort; null for someone the caller cannot see. */
function linkNameExpression(tx: TransactionSql): Fragment {
  return tx`coalesce(
    (SELECT concat_ws(' ', coalesce(nullif(s.preferred_name, ''), s.first_name), s.last_name)
       FROM app.students AS s WHERE s.school_id = r.school_id AND s.id = r.student_id),
    (SELECT u.display_name FROM app.users AS u WHERE u.school_id = r.school_id AND u.id = r.user_id),
    (SELECT c.code FROM app.classes AS c WHERE c.school_id = r.school_id AND c.id = r.class_id)
  )`;
}

function activeColumn(columns: readonly ColumnRow[], columnId: string): ColumnRow {
  const column = columns.find((candidate) => candidate.id === columnId && !candidate.archived_at);
  if (!column) invalid("That column is not on the list");
  // A sensitive cell is ciphertext: it can be neither compared nor ordered, and must not be probed.
  if (column.sensitivity === "sensitive")
    invalid("A sensitive column cannot be sorted or filtered");
  return column;
}

function sortExpression(tx: TransactionSql, column: ColumnRow): Fragment {
  const cell = (value: Fragment) => tx`(
    SELECT ${value} FROM app.custom_list_values AS v
    WHERE v.school_id = r.school_id AND v.row_id = r.id AND v.column_id = ${column.id}::uuid
    LIMIT 1
  )`;
  switch (column.field_type) {
    case "number":
      return cell(tx`v.value_number`);
    case "date":
      return cell(tx`v.value_date`);
    case "yes_no":
      return cell(tx`v.value_bool`);
    case "single_choice":
    case "multi_choice":
      return tx`(
        SELECT min(o.sort_order) FROM app.custom_list_values AS v
        JOIN app.custom_list_column_options AS o ON o.id = v.option_id AND o.school_id = v.school_id
        WHERE v.school_id = r.school_id AND v.row_id = r.id AND v.column_id = ${column.id}::uuid
      )`;
    default:
      return cell(tx`lower(v.value_text)`);
  }
}

function filterCondition(tx: TransactionSql, column: ColumnRow, raw: string): Fragment {
  const exists = (condition: Fragment) => tx`EXISTS (
    SELECT 1 FROM app.custom_list_values AS v
    WHERE v.school_id = r.school_id AND v.row_id = r.id AND v.column_id = ${column.id}::uuid
      AND ${condition}
  )`;
  switch (column.field_type) {
    case "number":
    case "date":
    case "yes_no": {
      const normalized = normalizeCell(column, raw);
      if (!normalized.ok || normalized.value === null) {
        invalid(`That is not a value of the column ${column.label_en}`);
      }
      if (column.field_type === "number") {
        return exists(tx`v.value_number = ${String(normalized.value)}::numeric`);
      }
      if (column.field_type === "date") {
        return exists(tx`v.value_date = ${String(normalized.value)}::date`);
      }
      return exists(tx`v.value_bool = ${normalized.value === true}`);
    }
    case "single_choice":
    case "multi_choice": {
      // One choice, by its value or either label.
      const normalized = normalizeCell({ ...column, field_type: "single_choice" }, raw);
      if (!normalized.ok || normalized.value === null) {
        invalid(`That is not a choice of the column ${column.label_en}`);
      }
      const option = column.options.find((candidate) => candidate.value === normalized.value)!;
      return exists(tx`v.option_id = ${option.id}::uuid`);
    }
    default:
      return exists(tx`v.value_text ILIKE ${likePattern(raw)}`);
  }
}

export async function listRows(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  query: CustomListRowsQuery,
): Promise<CustomListRowPageDto> {
  const list = await findList(tx, actor.schoolId, listId);
  const columns = await loadColumns(tx, actor.schoolId, [list.id]);

  const conditions: Fragment[] = [];
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(tx`AND (
      EXISTS (
        SELECT 1 FROM app.custom_list_values AS v
        JOIN app.custom_list_columns AS c
          ON c.id = v.column_id AND c.school_id = v.school_id AND c.archived_at IS NULL
        LEFT JOIN app.custom_list_column_options AS o
          ON o.id = v.option_id AND o.school_id = v.school_id
        WHERE v.school_id = r.school_id AND v.row_id = r.id AND v.value_ciphertext IS NULL
          AND (
            v.value_text ILIKE ${pattern}
            OR v.value_number::text ILIKE ${pattern}
            OR to_char(v.value_date, 'YYYY-MM-DD') ILIKE ${pattern}
            OR o.label_en ILIKE ${pattern}
            OR o.label_ar ILIKE ${pattern}
          )
      )
      OR ${linkNameExpression(tx)} ILIKE ${pattern}
    )`);
  }
  if (query.filter_column) {
    if (query.filter_value === undefined || query.filter_value === "") {
      invalid("filter_value is required with filter_column");
    }
    const column = activeColumn(columns, query.filter_column);
    conditions.push(tx`AND ${filterCondition(tx, column, query.filter_value)}`);
  }
  if (query.link_kind === "none") conditions.push(tx`AND r.link_kind IS NULL`);
  else if (query.link_kind) {
    conditions.push(tx`AND r.link_kind = ${query.link_kind}::app.custom_list_link_kind`);
  }

  const sort = query.sort ?? "created_at";
  const direction = query.order === "desc" ? tx`DESC` : tx`ASC`;
  let sortBy: Fragment;
  if (sort === "created_at") sortBy = tx`r.created_at`;
  else if (sort === "updated_at") sortBy = tx`r.updated_at`;
  else if (sort === "link") sortBy = tx`lower(${linkNameExpression(tx)})`;
  // Anything else is a column id: the query schema admits nothing but these four shapes.
  else sortBy = sortExpression(tx, activeColumn(columns, sort));

  const rows = await tx<(StoredRow & { total_count: number })[]>`
    SELECT ${ROW_COLUMNS(tx)}, count(*) OVER ()::int AS total_count
    FROM app.custom_list_rows AS r
    WHERE r.school_id = ${actor.schoolId}::uuid AND r.list_id = ${list.id}::uuid
      ${conditions.reduce((all, condition) => tx`${all} ${condition}`, tx``)}
    ORDER BY ${sortBy} ${direction} NULLS LAST, r.created_at, r.id
    LIMIT ${query.limit} OFFSET ${query.offset}
  `;
  let total = rows[0]?.total_count ?? 0;
  if (rows.length === 0 && query.offset > 0) {
    const [probe] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.custom_list_rows AS r
      WHERE r.school_id = ${actor.schoolId}::uuid AND r.list_id = ${list.id}::uuid
        ${conditions.reduce((all, condition) => tx`${all} ${condition}`, tx``)}
    `;
    total = probe?.total ?? 0;
  }
  return {
    rows: await hydrate(tx, actor.schoolId, rows, columns),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface PlannedCells {
  inserts: ValueInsert[];
  touched: string[];
  /** For the audit row: standard cells' values, sensitive cells only by column id. */
  audit: Record<string, unknown>;
}

function planCells(
  scope: CellScope,
  keyring: RecordKeyring,
  rowId: string,
  columns: readonly ColumnRow[],
  values: readonly { column_id: string; value: RecordValue | null }[],
): PlannedCells {
  const planned: PlannedCells = { inserts: [], touched: [], audit: {} };
  const seen = new Set<string>();
  for (const input of values) {
    if (seen.has(input.column_id)) invalid("Each column may appear once");
    seen.add(input.column_id);
    const column = columns.find((candidate) => candidate.id === input.column_id);
    if (!column) invalid("That column is not on the list");
    if (column.archived_at) invalid(`The column ${column.label_en} is archived`);
    const normalized = normalizeCell(column, input.value);
    if (!normalized.ok) cellInvalid(column, normalized.error);
    if (normalized.value === null && column.required) cellInvalid(column, "required");
    planned.touched.push(column.id);
    planned.audit[column.id] =
      column.sensitivity === "sensitive" ? { sensitive: true, changed: true } : normalized.value;
    if (normalized.value !== null) {
      planned.inserts.push(...valueRows(scope, keyring, rowId, column, normalized.value));
    }
  }
  return planned;
}

export async function createRow(
  tx: TransactionSql,
  actor: CustomListActor,
  keyring: RecordKeyring,
  listId: string,
  input: CreateCustomListRowInput,
): Promise<CustomListRowDto> {
  const list = await findList(tx, actor.schoolId, listId);
  if (list.archived_at) invalid("An archived list cannot take new rows");
  const columns = await loadColumns(tx, actor.schoolId, [list.id]);
  const link = input.link ?? null;
  if (link) await assertLinkTarget(tx, actor.schoolId, list, link);

  const missing = columns.filter(
    (column) =>
      column.required &&
      !column.archived_at &&
      !input.values.some((cell) => cell.column_id === column.id && cell.value !== null),
  );
  if (missing.length > 0) cellInvalid(missing[0]!, "required");

  await lockSchoolLists(tx, actor.schoolId);
  await assertRowRoom(tx, actor.schoolId, list.id, 1);

  const linked = linkColumns(link);
  const [created] = await tx<StoredRow[]>`
    INSERT INTO app.custom_list_rows AS r (
      school_id, list_id, link_kind, student_id, user_id, class_id, created_by, updated_by
    ) VALUES (
      ${actor.schoolId}::uuid, ${list.id}::uuid, ${linked.link_kind}::app.custom_list_link_kind,
      ${linked.student_id}::uuid, ${linked.user_id}::uuid, ${linked.class_id}::uuid,
      ${actor.userId}::uuid, ${actor.userId}::uuid
    )
    RETURNING ${ROW_COLUMNS(tx)}
  `;
  const scope = { schoolId: actor.schoolId, listId: list.id, userId: actor.userId };
  const planned = planCells(scope, keyring, created!.id, columns, input.values);
  await insertValues(tx, planned.inserts);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "custom_list_rows",
    targetId: created!.id,
    newValues: {
      list_id: list.id,
      link_kind: link?.kind ?? null,
      link_id: link?.id ?? null,
      cells: planned.audit,
    },
  });
  const [dto] = await hydrate(tx, actor.schoolId, [created!], columns);
  return dto!;
}

export async function updateRow(
  tx: TransactionSql,
  actor: CustomListActor,
  keyring: RecordKeyring,
  listId: string,
  rowId: string,
  input: UpdateCustomListRowInput,
): Promise<CustomListRowDto> {
  const list = await findList(tx, actor.schoolId, listId);
  const columns = await loadColumns(tx, actor.schoolId, [list.id]);
  const current = await findRow(tx, actor.schoolId, list.id, rowId, { forUpdate: true });

  let link: RowLinkInput | null =
    current.link_kind && linkTargetId(current)
      ? { kind: current.link_kind, id: linkTargetId(current)! }
      : null;
  if (input.link !== undefined) {
    link = input.link;
    if (link) await assertLinkTarget(tx, actor.schoolId, list, link);
  }
  const columnsLink = linkColumns(link);
  const scope = { schoolId: actor.schoolId, listId: list.id, userId: actor.userId };
  const planned = planCells(scope, keyring, rowId, columns, input.values ?? []);
  await clearCells(tx, actor.schoolId, rowId, planned.touched);
  await insertValues(tx, planned.inserts);

  const [updated] = await tx<StoredRow[]>`
    UPDATE app.custom_list_rows AS r
    SET link_kind = ${columnsLink.link_kind}::app.custom_list_link_kind,
        student_id = ${columnsLink.student_id}::uuid,
        user_id = ${columnsLink.user_id}::uuid,
        class_id = ${columnsLink.class_id}::uuid,
        updated_by = ${actor.userId}::uuid,
        updated_at = CURRENT_TIMESTAMP
    WHERE r.school_id = ${actor.schoolId}::uuid AND r.id = ${rowId}::uuid
    RETURNING ${ROW_COLUMNS(tx)}
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "custom_list_rows",
    targetId: rowId,
    oldValues: { link_kind: current.link_kind, link_id: linkTargetId(current) },
    newValues: {
      list_id: list.id,
      link_kind: link?.kind ?? null,
      link_id: link?.id ?? null,
      cells: planned.audit,
    },
  });
  const [dto] = await hydrate(tx, actor.schoolId, [updated!], columns);
  return dto!;
}

export async function deleteRow(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  rowId: string,
): Promise<void> {
  const list = await findList(tx, actor.schoolId, listId);
  const current = await findRow(tx, actor.schoolId, list.id, rowId, { forUpdate: true });
  // Values cascade (000182).
  await tx`
    DELETE FROM app.custom_list_rows WHERE school_id = ${actor.schoolId}::uuid AND id = ${rowId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "custom_list_rows",
    targetId: rowId,
    oldValues: { list_id: list.id, link_kind: current.link_kind, link_id: linkTargetId(current) },
  });
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

export async function revealCell(
  tx: TransactionSql,
  actor: CustomListActor,
  keyring: RecordKeyring,
  listId: string,
  rowId: string,
  columnId: string,
): Promise<{ column_id: string; value: RecordValue | null }> {
  const list = await findList(tx, actor.schoolId, listId);
  await findRow(tx, actor.schoolId, list.id, rowId);
  const columns = await loadColumns(tx, actor.schoolId, [list.id]);
  const column = columns.find((candidate) => candidate.id === columnId) ?? notFound("column");
  if (column.sensitivity !== "sensitive") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RECORD_FIELD_NOT_SENSITIVE,
      "Only a sensitive column is revealed",
    );
  }
  // Audited before anything is opened: who, when, which list, row and column -- never the value.
  await emitAuditLog(tx, {
    action: "read",
    targetTable: "custom_list_values",
    targetId: rowId,
    newValues: { list_id: list.id, row_id: rowId, column_id: columnId, reveal: true },
  });
  const [sealed] = await tx<
    {
      value_ciphertext: Uint8Array | null;
      value_key_id: string | null;
      value_mask: string | null;
    }[]
  >`
    SELECT value_ciphertext, value_key_id, value_mask FROM app.custom_list_values
    WHERE school_id = ${actor.schoolId}::uuid AND row_id = ${rowId}::uuid
      AND column_id = ${columnId}::uuid
    LIMIT 1
  `;
  if (!sealed?.value_ciphertext) return { column_id: columnId, value: null };
  return {
    column_id: columnId,
    value: openCell(keyring, actor.schoolId, rowId, columnId, {
      value_ciphertext: sealed.value_ciphertext,
      value_key_id: sealed.value_key_id!,
      value_mask: sealed.value_mask!,
    }),
  };
}

// ---------------------------------------------------------------------------
// CSV export -- sensitive columns are never in it
// ---------------------------------------------------------------------------

/** U+FEFF, so spreadsheet apps read the Arabic as UTF-8. */
const UTF8_BOM = String.fromCharCode(0xfeff);
const YES_NO = { en: ["Yes", "No"], ar: ["نعم", "لا"] } as const;
const HEADERS = {
  en: { kind: "Linked to (type)", name: "Linked to", added: "Added on" },
  ar: { kind: "مرتبط بـ (النوع)", name: "مرتبط بـ", added: "تاريخ الإضافة" },
} as const;
const KIND_LABELS = {
  en: { student: "Student", parent: "Parent", staff: "Staff", class: "Class" },
  ar: { student: "طالب", parent: "ولي أمر", staff: "موظف", class: "صف" },
} as const;

/**
 * One CSV cell. Text that a spreadsheet would read as a formula (=, +, -, @, tab, carriage return)
 * is prefixed with an apostrophe, so an exported list cannot run anything when opened.
 */
function csvCell(value: string, numeric = false): string {
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportCsv(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  lang: "en" | "ar",
): Promise<{ fileName: string; csv: string }> {
  const list = await findList(tx, actor.schoolId, listId);
  const allColumns = await loadColumns(tx, actor.schoolId, [list.id]);
  const active = allColumns.filter((column) => !column.archived_at);
  const exported = active.filter((column) => column.sensitivity !== "sensitive");
  const rows = await tx<StoredRow[]>`
    SELECT ${ROW_COLUMNS(tx)} FROM app.custom_list_rows AS r
    WHERE r.school_id = ${actor.schoolId}::uuid AND r.list_id = ${list.id}::uuid
    ORDER BY r.created_at, r.id
  `;
  const cells = await loadCells(
    tx,
    actor.schoolId,
    rows.map((row) => row.id),
    exported,
  );
  const names = await linkNames(tx, actor.schoolId, rows);
  const hasLinks = list.link_student || list.link_parent || list.link_staff || list.link_class;

  const label = (option: { label_en: string; label_ar: string }) =>
    lang === "ar" ? option.label_ar : option.label_en;
  const text = (column: ColumnRow, cell: Cell | undefined): string => {
    if (!cell || cell.value === null) return "";
    const optionLabel = (value: string) =>
      label(
        column.options.find((option) => option.value === value) ?? {
          label_en: value,
          label_ar: value,
        },
      );
    switch (column.field_type) {
      case "yes_no":
        return YES_NO[lang][cell.value === true ? 0 : 1];
      case "single_choice":
        return optionLabel(String(cell.value));
      case "multi_choice":
        return (cell.value as string[]).map(optionLabel).join("; ");
      default:
        return String(cell.value);
    }
  };

  const header = [
    ...(hasLinks ? [HEADERS[lang].kind, HEADERS[lang].name] : []),
    ...exported.map(label),
    HEADERS[lang].added,
  ];
  const lines = [header.map((value) => csvCell(value)).join(",")];
  for (const row of rows) {
    const rowCells = cells.get(row.id) ?? [];
    const target = linkTargetId(row);
    lines.push(
      [
        ...(hasLinks
          ? [
              csvCell(row.link_kind ? KIND_LABELS[lang][row.link_kind] : ""),
              csvCell(target ? (names.get(target) ?? "") : ""),
            ]
          : []),
        ...exported.map((column) =>
          csvCell(
            text(
              column,
              rowCells.find((cell) => cell.column_id === column.id),
            ),
            column.field_type === "number",
          ),
        ),
        csvCell(row.created_at.toISOString().slice(0, 10), true),
      ].join(","),
    );
  }

  await emitAuditLog(tx, {
    action: "export",
    targetTable: "custom_lists",
    targetId: list.id,
    newValues: {
      rows: rows.length,
      columns: exported.length,
      sensitive_columns_left_out: active.length - exported.length,
    },
  });

  const slug = list.name_en
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return { fileName: `${slug || "custom-list"}.csv`, csv: `${UTF8_BOM}${lines.join("\r\n")}\r\n` };
}

// ---------------------------------------------------------------------------
// A subject's Lists panel
// ---------------------------------------------------------------------------

function subjectCondition(
  tx: TransactionSql,
  kind: CustomListLinkKind,
  subjectId: string,
): Fragment {
  switch (kind) {
    case "student":
      return tx`r.student_id = ${subjectId}::uuid`;
    case "class":
      return tx`r.class_id = ${subjectId}::uuid`;
    default:
      return tx`r.user_id = ${subjectId}::uuid`;
  }
}

export async function linkedRows(
  tx: TransactionSql,
  actor: CustomListActor,
  kind: CustomListLinkKind,
  subjectId: string,
): Promise<CustomListLinkedDto> {
  // Lists outside the caller's audience, and their rows, are hidden by RLS (000182).
  const rows = await tx<(StoredRow & { name_en: string; name_ar: string; total_count: number })[]>`
    SELECT * FROM (
      SELECT ${ROW_COLUMNS(tx)}, l.name_en, l.name_ar,
             row_number() OVER (PARTITION BY r.list_id ORDER BY r.created_at, r.id) AS position,
             count(*) OVER (PARTITION BY r.list_id)::int AS total_count,
             lower(l.name_en) AS list_order
      FROM app.custom_list_rows AS r
      JOIN app.custom_lists AS l ON l.id = r.list_id AND l.school_id = r.school_id
      WHERE r.school_id = ${actor.schoolId}::uuid
        AND l.archived_at IS NULL
        AND r.link_kind = ${kind}::app.custom_list_link_kind
        AND ${subjectCondition(tx, kind, subjectId)}
    ) AS linked
    WHERE position <= ${MAX_LINKED_ROWS_PER_LIST}
    ORDER BY list_order, list_id, position
  `;
  const listIds = [...new Set(rows.map((row) => row.list_id))];
  const columns = await loadColumns(tx, actor.schoolId, listIds);
  const result: CustomListLinkedDto["lists"] = [];
  for (const listId of listIds) {
    const listRows = rows.filter((row) => row.list_id === listId);
    const listColumns = columns.filter((candidate) => candidate.list_id === listId);
    result.push({
      list: { id: listId, name_en: listRows[0]!.name_en, name_ar: listRows[0]!.name_ar },
      columns: listColumns.filter((candidate) => !candidate.archived_at).map(columnDto),
      rows: await hydrate(tx, actor.schoolId, listRows, listColumns),
      total: listRows[0]!.total_count,
    });
  }
  return { lists: result };
}
