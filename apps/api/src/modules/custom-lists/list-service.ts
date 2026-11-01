/**
 * Custom lists and their columns (docs/modules/custom-lists.md, 000182).
 *
 * Every read runs under the caller's own RLS scope: app.custom_lists' role_scope_visibility policy
 * hides a list outside the caller's audience, so a list the caller may not use is simply not found
 * (404, never 403, so ids cannot be probed). Writes that add lists or rows take a per-school
 * advisory lock so the caps hold under concurrent requests.
 */

import { ERROR_CODES, ROLES, SCHOOL_STAFF_ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  MAX_COLUMNS_PER_LIST,
  MAX_LISTS_PER_SCHOOL,
  MAX_ROWS_PER_LIST,
  MAX_ROWS_PER_SCHOOL,
} from "./limits";

import type {
  CreateCustomListInput,
  CustomListAudience,
  CustomListColumnDto,
  CustomListDetailDto,
  CustomListLinkKind,
  CustomListLinks,
  CustomListSummaryDto,
  NewCustomListColumnInput,
  UpdateCustomListColumnInput,
  UpdateCustomListInput,
} from "./schemas";
import type { Role } from "@studafy/constants";
import type { RecordFieldOption, RecordFieldSensitivity, RecordFieldType } from "@studafy/records";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/** Mirrors app.can_read_custom_list (000182). SUPER_ADMIN counts as ORG_ADMIN, as it does there. */
const AUDIENCE_ROLES: Readonly<Record<CustomListAudience, readonly Role[]>> = {
  admins: [ROLES.ORG_ADMIN, ROLES.SUPER_ADMIN],
  leadership: [ROLES.ORG_ADMIN, ROLES.SUPER_ADMIN, ROLES.PRINCIPAL],
  staff: [...SCHOOL_STAFF_ROLES, ROLES.SUPER_ADMIN],
};

export function reachesAudience(roles: readonly string[], audience: CustomListAudience): boolean {
  return AUDIENCE_ROLES[audience].some((role) => roles.includes(role));
}

/**
 * Who is acting: their roles decide which audiences they may give a list (never one that would
 * hide it from them) and whether they may manage the lists they see.
 */
export interface CustomListActor {
  schoolId: string;
  userId: string;
  roles: readonly string[];
  canManage: boolean;
}

// ---------------------------------------------------------------------------
// Rows as stored
// ---------------------------------------------------------------------------

export interface ListRow {
  id: string;
  name_en: string;
  name_ar: string;
  description: string | null;
  audience: CustomListAudience;
  link_student: boolean;
  link_parent: boolean;
  link_staff: boolean;
  link_class: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ColumnRow {
  id: string;
  list_id: string;
  field_type: Exclude<RecordFieldType, "document">;
  label_en: string;
  label_ar: string;
  required: boolean;
  sensitivity: RecordFieldSensitivity;
  sort_order: number;
  archived_at: Date | null;
  options: (RecordFieldOption & { id: string })[];
}

export function notFound(what = "list"): never {
  throw new CodedHttpException(404, ERROR_CODES.CUSTOM_LIST_NOT_FOUND, `Custom ${what} not found`);
}

export function invalid(message: string): never {
  throw new CodedHttpException(422, ERROR_CODES.CUSTOM_LIST_INVALID, message);
}

function limitReached(message: string): never {
  throw new CodedHttpException(409, ERROR_CODES.CUSTOM_LIST_LIMIT_REACHED, message);
}

export function linksOf(list: ListRow): CustomListLinks {
  return {
    student: list.link_student,
    parent: list.link_parent,
    staff: list.link_staff,
    class: list.link_class,
  };
}

export function allowsLink(list: ListRow, kind: CustomListLinkKind): boolean {
  return linksOf(list)[kind];
}

/** Serializes cap-checked writes of one school (new lists, new rows). */
export async function lockSchoolLists(tx: TransactionSql, schoolId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`custom_lists:${schoolId}`}, 0))`;
}

export async function findList(
  tx: TransactionSql,
  schoolId: string,
  listId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ListRow> {
  const [row] = await tx<ListRow[]>`
    SELECT id, name_en, name_ar, description, audience::text AS audience, link_student,
           link_parent, link_staff, link_class, archived_at, created_at, updated_at
    FROM app.custom_lists
    WHERE school_id = ${schoolId}::uuid AND id = ${listId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE` : tx``}
  `;
  return row ?? notFound();
}

export async function loadColumns(
  tx: TransactionSql,
  schoolId: string,
  listIds: readonly string[],
): Promise<ColumnRow[]> {
  if (listIds.length === 0) return [];
  const columns = await tx<Omit<ColumnRow, "options">[]>`
    SELECT id, list_id, field_type::text AS field_type, label_en, label_ar, required,
           sensitivity::text AS sensitivity, sort_order, archived_at
    FROM app.custom_list_columns
    WHERE school_id = ${schoolId}::uuid AND list_id = ANY(${listIds as string[]}::uuid[])
    ORDER BY list_id, sort_order, created_at, id
  `;
  const options = await tx<(RecordFieldOption & { id: string; column_id: string })[]>`
    SELECT id, column_id, value, label_en, label_ar
    FROM app.custom_list_column_options
    WHERE school_id = ${schoolId}::uuid AND list_id = ANY(${listIds as string[]}::uuid[])
    ORDER BY column_id, sort_order, id
  `;
  const byColumn = new Map<string, ColumnRow["options"]>();
  for (const { column_id, ...option } of options) {
    const list = byColumn.get(column_id) ?? [];
    list.push(option);
    byColumn.set(column_id, list);
  }
  return columns.map((column) => ({ ...column, options: byColumn.get(column.id) ?? [] }));
}

export function columnDto(column: ColumnRow): CustomListColumnDto {
  return {
    id: column.id,
    field_type: column.field_type,
    label_en: column.label_en,
    label_ar: column.label_ar,
    required: column.required,
    sensitivity: column.sensitivity,
    sort_order: column.sort_order,
    archived: column.archived_at !== null,
    options: column.options.map(({ value, label_en, label_ar }) => ({ value, label_en, label_ar })),
  };
}

function summaryDto(
  list: ListRow,
  counts: { row_count: number; column_count: number },
  actor: CustomListActor,
): CustomListSummaryDto {
  return {
    id: list.id,
    name_en: list.name_en,
    name_ar: list.name_ar,
    description: list.description,
    audience: list.audience,
    links: linksOf(list),
    archived: list.archived_at !== null,
    row_count: counts.row_count,
    column_count: counts.column_count,
    can_manage: actor.canManage,
    created_at: list.created_at.toISOString(),
    updated_at: list.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listLists(
  tx: TransactionSql,
  actor: CustomListActor,
  includeArchived: boolean,
): Promise<CustomListSummaryDto[]> {
  const rows = await tx<(ListRow & { row_count: number; column_count: number })[]>`
    SELECT l.id, l.name_en, l.name_ar, l.description, l.audience::text AS audience,
           l.link_student, l.link_parent, l.link_staff, l.link_class, l.archived_at,
           l.created_at, l.updated_at,
           (SELECT count(*)::int FROM app.custom_list_rows r
             WHERE r.school_id = l.school_id AND r.list_id = l.id) AS row_count,
           (SELECT count(*)::int FROM app.custom_list_columns c
             WHERE c.school_id = l.school_id AND c.list_id = l.id AND c.archived_at IS NULL)
             AS column_count
    FROM app.custom_lists l
    WHERE l.school_id = ${actor.schoolId}::uuid
      ${includeArchived ? tx`` : tx`AND l.archived_at IS NULL`}
    ORDER BY lower(l.name_en), l.id
  `;
  return rows.map((row) => summaryDto(row, row, actor));
}

export async function getListDetail(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
): Promise<CustomListDetailDto> {
  const list = await findList(tx, actor.schoolId, listId);
  const columns = await loadColumns(tx, actor.schoolId, [list.id]);
  const [counts] = await tx<{ row_count: number }[]>`
    SELECT count(*)::int AS row_count FROM app.custom_list_rows
    WHERE school_id = ${actor.schoolId}::uuid AND list_id = ${list.id}::uuid
  `;
  return {
    ...summaryDto(
      list,
      {
        row_count: counts?.row_count ?? 0,
        column_count: columns.filter((column) => column.archived_at === null).length,
      },
      actor,
    ),
    columns: columns.map(columnDto),
  };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function assertAudience(actor: CustomListActor, audience: CustomListAudience): void {
  // A list its own manager could not see would be lost to them; refuse rather than hide it.
  if (!reachesAudience(actor.roles, audience)) {
    invalid("Choose an audience you belong to, or the list would be hidden from you");
  }
}

function nameTaken(): never {
  throw new CodedHttpException(409, ERROR_CODES.CUSTOM_LIST_NAME_TAKEN, "List name already used");
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505" &&
    (error as { constraint_name?: string }).constraint_name === constraint
  );
}

/** Insert or update a list, turning the school-wide name index's violation into 409. */
async function withNameCheck<T>(tx: TransactionSql, fn: () => Promise<T>): Promise<T> {
  // A savepoint, so the violation does not abort the caller's transaction.
  try {
    return (await tx.savepoint(fn)) as T;
  } catch (error) {
    if (isUniqueViolation(error, "uq_custom_lists_school_name_en")) nameTaken();
    throw error;
  }
}

export async function createList(
  tx: TransactionSql,
  actor: CustomListActor,
  input: CreateCustomListInput,
): Promise<string> {
  assertAudience(actor, input.audience);
  const columns = input.columns ?? [];
  if (columns.length > MAX_COLUMNS_PER_LIST) {
    limitReached(`A list has at most ${MAX_COLUMNS_PER_LIST} columns`);
  }
  for (const column of columns) assertColumnDefinition(column);

  await lockSchoolLists(tx, actor.schoolId);
  if ((await schoolUsage(tx)).lists >= MAX_LISTS_PER_SCHOOL) {
    limitReached(`A school keeps at most ${MAX_LISTS_PER_SCHOOL} custom lists`);
  }

  const [list] = await withNameCheck(
    tx,
    () => tx<{ id: string }[]>`
      INSERT INTO app.custom_lists (
        school_id, name_en, name_ar, description, audience, link_student, link_parent,
        link_staff, link_class, created_by
      ) VALUES (
        ${actor.schoolId}::uuid, ${input.name_en}, ${input.name_ar},
        ${emptyAsNull(input.description)}, ${input.audience}::app.custom_list_audience,
        ${input.links.student}, ${input.links.parent}, ${input.links.staff}, ${input.links.class},
        ${actor.userId}::uuid
      )
      RETURNING id
    `,
  );
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "custom_lists",
    targetId: list!.id,
    newValues: {
      name_en: input.name_en,
      name_ar: input.name_ar,
      audience: input.audience,
      links: input.links,
      columns: columns.length,
    },
  });
  for (const [index, column] of columns.entries()) {
    await insertColumn(tx, actor, list!.id, column, index);
  }
  return list!.id;
}

/**
 * The school's list and row totals, whoever may see them: app.custom_list_usage (000182) counts
 * past the audience scope, which would otherwise let a principal pass the caps while admin-only
 * lists sit unseen.
 */
async function schoolUsage(tx: TransactionSql): Promise<{ lists: number; list_rows: number }> {
  const [row] = await tx<{ lists: number; list_rows: number }[]>`
    SELECT lists, list_rows FROM app.custom_list_usage()
  `;
  return row ?? { lists: 0, list_rows: 0 };
}

function emptyAsNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function updateList(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  input: UpdateCustomListInput,
): Promise<void> {
  const current = await findList(tx, actor.schoolId, listId, { forUpdate: true });
  if (input.audience) assertAudience(actor, input.audience);
  const links = input.links ?? linksOf(current);
  // Narrowing the links must not orphan rows already linked that way.
  for (const kind of ["student", "parent", "staff", "class"] as const) {
    if (linksOf(current)[kind] && !links[kind]) {
      const [used] = await tx<{ used: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM app.custom_list_rows
          WHERE school_id = ${actor.schoolId}::uuid AND list_id = ${listId}::uuid
            AND link_kind = ${kind}::app.custom_list_link_kind
        ) AS used
      `;
      if (used?.used) invalid(`Rows are linked to a ${kind}; unlink them before turning that off`);
    }
  }
  const next = {
    name_en: input.name_en ?? current.name_en,
    name_ar: input.name_ar ?? current.name_ar,
    description:
      input.description === undefined ? current.description : emptyAsNull(input.description),
    audience: input.audience ?? current.audience,
  };
  const archived = input.archived === undefined ? current.archived_at !== null : input.archived;
  await withNameCheck(
    tx,
    () => tx`
      UPDATE app.custom_lists
      SET name_en = ${next.name_en}, name_ar = ${next.name_ar}, description = ${next.description},
          audience = ${next.audience}::app.custom_list_audience,
          link_student = ${links.student}, link_parent = ${links.parent},
          link_staff = ${links.staff}, link_class = ${links.class},
          archived_at = ${archived ? tx`coalesce(archived_at, CURRENT_TIMESTAMP)` : null},
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${actor.schoolId}::uuid AND id = ${listId}::uuid
    `,
  );
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "custom_lists",
    targetId: listId,
    oldValues: {
      name_en: current.name_en,
      name_ar: current.name_ar,
      audience: current.audience,
      links: linksOf(current),
      archived: current.archived_at !== null,
    },
    newValues: { ...next, description: undefined, links, archived },
  });
}

export async function deleteList(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
): Promise<void> {
  const current = await findList(tx, actor.schoolId, listId, { forUpdate: true });
  const [counts] = await tx<{ rows: number }[]>`
    SELECT count(*)::int AS rows FROM app.custom_list_rows
    WHERE school_id = ${actor.schoolId}::uuid AND list_id = ${listId}::uuid
  `;
  // Columns, options, rows and values cascade (000182).
  await tx`DELETE FROM app.custom_lists WHERE school_id = ${actor.schoolId}::uuid AND id = ${listId}::uuid`;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "custom_lists",
    targetId: listId,
    oldValues: { name_en: current.name_en, name_ar: current.name_ar, rows: counts?.rows ?? 0 },
  });
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function isChoice(fieldType: RecordFieldType): boolean {
  return fieldType === "single_choice" || fieldType === "multi_choice";
}

function assertOptions(fieldType: RecordFieldType, options: readonly RecordFieldOption[]): void {
  if (isChoice(fieldType) && options.length === 0)
    invalid("A choice column needs at least one option");
  if (!isChoice(fieldType) && options.length > 0) invalid("Only choice columns have options");
  const values = options.map((option) => option.value);
  if (new Set(values).size !== values.length) invalid("Option values must be unique");
}

export function assertColumnDefinition(column: NewCustomListColumnInput): void {
  assertOptions(column.field_type, column.options ?? []);
}

async function insertColumn(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  column: NewCustomListColumnInput,
  sortOrder: number,
): Promise<string> {
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO app.custom_list_columns (
      school_id, list_id, field_type, label_en, label_ar, required, sensitivity, sort_order,
      created_by
    ) VALUES (
      ${actor.schoolId}::uuid, ${listId}::uuid, ${column.field_type}::app.record_field_type,
      ${column.label_en}, ${column.label_ar}, ${column.required ?? false},
      ${column.sensitivity ?? "standard"}::app.record_field_sensitivity, ${sortOrder},
      ${actor.userId}::uuid
    )
    RETURNING id
  `;
  await insertOptions(tx, actor.schoolId, listId, created!.id, column.options ?? [], 0);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "custom_list_columns",
    targetId: created!.id,
    newValues: {
      list_id: listId,
      field_type: column.field_type,
      label_en: column.label_en,
      label_ar: column.label_ar,
      sensitivity: column.sensitivity ?? "standard",
      required: column.required ?? false,
    },
  });
  return created!.id;
}

async function insertOptions(
  tx: TransactionSql,
  schoolId: string,
  listId: string,
  columnId: string,
  options: readonly RecordFieldOption[],
  firstSortOrder: number,
): Promise<void> {
  for (const [index, option] of options.entries()) {
    await tx`
      INSERT INTO app.custom_list_column_options (
        school_id, list_id, column_id, value, label_en, label_ar, sort_order
      ) VALUES (
        ${schoolId}::uuid, ${listId}::uuid, ${columnId}::uuid, ${option.value},
        ${option.label_en}, ${option.label_ar}, ${firstSortOrder + index}
      )
    `;
  }
}

export async function addColumn(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  column: NewCustomListColumnInput,
): Promise<string> {
  await findList(tx, actor.schoolId, listId, { forUpdate: true });
  assertColumnDefinition(column);
  const [stats] = await tx<{ active: number; next_order: number }[]>`
    SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS active,
           coalesce(max(sort_order) + 1, 0)::int AS next_order
    FROM app.custom_list_columns
    WHERE school_id = ${actor.schoolId}::uuid AND list_id = ${listId}::uuid
  `;
  if ((stats?.active ?? 0) >= MAX_COLUMNS_PER_LIST) {
    limitReached(`A list has at most ${MAX_COLUMNS_PER_LIST} columns`);
  }
  await touchList(tx, actor.schoolId, listId);
  return insertColumn(tx, actor, listId, column, stats?.next_order ?? 0);
}

async function touchList(tx: TransactionSql, schoolId: string, listId: string): Promise<void> {
  await tx`
    UPDATE app.custom_lists SET updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${listId}::uuid
  `;
}

export async function updateColumn(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  columnId: string,
  input: UpdateCustomListColumnInput,
): Promise<void> {
  await findList(tx, actor.schoolId, listId, { forUpdate: true });
  const columns = await loadColumns(tx, actor.schoolId, [listId]);
  const column = columns.find((candidate) => candidate.id === columnId) ?? notFound("column");

  if (input.archived === false && column.archived_at !== null) {
    const active = columns.filter((candidate) => candidate.archived_at === null).length;
    if (active >= MAX_COLUMNS_PER_LIST) {
      limitReached(`A list has at most ${MAX_COLUMNS_PER_LIST} columns`);
    }
  }

  if (input.options) {
    assertOptions(column.field_type, input.options);
    const nextValues = new Set(input.options.map((option) => option.value));
    const removed = column.options.filter((option) => !nextValues.has(option.value));
    if (removed.length > 0) {
      const [used] = await tx<{ used: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM app.custom_list_values
          WHERE school_id = ${actor.schoolId}::uuid
            AND option_id = ANY(${removed.map((option) => option.id)}::uuid[])
        ) AS used
      `;
      if (used?.used) invalid("A choice some rows use cannot be removed; relabel it instead");
      await tx`
        DELETE FROM app.custom_list_column_options
        WHERE school_id = ${actor.schoolId}::uuid
          AND id = ANY(${removed.map((option) => option.id)}::uuid[])
      `;
    }
    for (const [index, option] of input.options.entries()) {
      const existing = column.options.find((candidate) => candidate.value === option.value);
      if (existing) {
        await tx`
          UPDATE app.custom_list_column_options
          SET label_en = ${option.label_en}, label_ar = ${option.label_ar}, sort_order = ${index}
          WHERE school_id = ${actor.schoolId}::uuid AND id = ${existing.id}::uuid
        `;
      } else {
        await insertOptions(tx, actor.schoolId, listId, columnId, [option], index);
      }
    }
  }

  const archived = input.archived ?? column.archived_at !== null;
  await tx`
    UPDATE app.custom_list_columns
    SET label_en = ${input.label_en ?? column.label_en},
        label_ar = ${input.label_ar ?? column.label_ar},
        required = ${input.required ?? column.required},
        archived_at = ${archived ? tx`coalesce(archived_at, CURRENT_TIMESTAMP)` : null},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${actor.schoolId}::uuid AND id = ${columnId}::uuid
  `;
  await touchList(tx, actor.schoolId, listId);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "custom_list_columns",
    targetId: columnId,
    oldValues: {
      label_en: column.label_en,
      label_ar: column.label_ar,
      required: column.required,
      archived: column.archived_at !== null,
      options: column.options.length,
    },
    newValues: {
      label_en: input.label_en ?? column.label_en,
      label_ar: input.label_ar ?? column.label_ar,
      required: input.required ?? column.required,
      archived,
      options: input.options?.length ?? column.options.length,
    },
  });
}

export async function reorderColumns(
  tx: TransactionSql,
  actor: CustomListActor,
  listId: string,
  columnIds: readonly string[],
): Promise<void> {
  await findList(tx, actor.schoolId, listId, { forUpdate: true });
  const columns = await loadColumns(tx, actor.schoolId, [listId]);
  const known = new Set(columns.map((column) => column.id));
  if (
    new Set(columnIds).size !== columnIds.length ||
    columnIds.length !== known.size ||
    !columnIds.every((id) => known.has(id))
  ) {
    invalid("column_ids must list every column of the list exactly once");
  }
  for (const [index, id] of columnIds.entries()) {
    await tx`
      UPDATE app.custom_list_columns SET sort_order = ${index}, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${actor.schoolId}::uuid AND id = ${id}::uuid
    `;
  }
  await touchList(tx, actor.schoolId, listId);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "custom_lists",
    targetId: listId,
    oldValues: { column_order: columns.map((column) => column.id) },
    newValues: { column_order: columnIds },
  });
}

// ---------------------------------------------------------------------------
// Row caps
// ---------------------------------------------------------------------------

/**
 * Throws when adding `adding` rows would pass either row cap. Call under lockSchoolLists. A new
 * list (an import) passes a null listId: only the school's cap applies.
 */
export async function assertRowRoom(
  tx: TransactionSql,
  schoolId: string,
  listId: string | null,
  adding: number,
): Promise<void> {
  if (adding > MAX_ROWS_PER_LIST) limitReached(`A list holds at most ${MAX_ROWS_PER_LIST} rows`);
  if (listId) {
    // The list is the caller's to see, so its own rows count under their scope.
    const [inList] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.custom_list_rows
      WHERE school_id = ${schoolId}::uuid AND list_id = ${listId}::uuid
    `;
    if ((inList?.total ?? 0) + adding > MAX_ROWS_PER_LIST) {
      limitReached(`A list holds at most ${MAX_ROWS_PER_LIST} rows`);
    }
  }
  if ((await schoolUsage(tx)).list_rows + adding > MAX_ROWS_PER_SCHOOL) {
    limitReached(`A school keeps at most ${MAX_ROWS_PER_SCHOOL} rows across its custom lists`);
  }
}
