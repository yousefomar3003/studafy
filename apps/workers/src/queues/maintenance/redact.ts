/**
 * The erasure primitive (ST-268): redact a table's personal-data-shaped columns in place, for one
 * school (tenant-wide erasure) or one subject within it (per-user DSR erasure). Never deletes a row
 * -- see retention-registry.ts's header for why redaction, not deletion, is this pipeline's only
 * erasure mechanism.
 *
 * Column discovery goes through information_schema rather than a hardcoded per-table column list,
 * for the same "don't hand-maintain a list that will drift" reason tenant-tables.ts discovers tables
 * that way: retention-registry.ts's PII_COLUMN_PATTERNS is the one place a column-naming decision is
 * made, and this module mechanically applies it to whatever the live schema actually has.
 */

import { isPersonalDataColumn } from "./retention-registry";

import type { ISql, TransactionSql } from "postgres";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Table/column names reaching this module come from information_schema (trusted catalog data) or
 * from retention-registry.ts's own constants, never from request input -- but every string this
 * module interpolates into raw SQL text is checked against this pattern regardless, so a future
 * caller that gets that wrong fails loudly instead of building an injectable query.
 */
export function assertSafeIdentifier(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`refusing to build erasure SQL for unsafe identifier: ${JSON.stringify(name)}`);
  }
}

/**
 * Data types a redaction value is known how to build for. `date` covers app.students.date_of_birth
 * specifically (which is nullable, so it only ever needs the NULL branch below); every currently
 * verified NOT NULL personal column is text/varchar. A PII-named column of a type outside this list
 * is reported by findRedactableColumns as "unredactable" rather than silently skipped, so a future
 * migration that adds e.g. a NOT NULL personal `date`/`jsonb` column fails a test instead of quietly
 * shipping unredacted.
 */
const REDACTABLE_DATA_TYPES: ReadonlySet<string> = new Set(["text", "character varying", "date"]);

export interface RedactableColumn {
  columnName: string;
  isNullable: boolean;
  dataType: string;
}

/**
 * Which of `table`'s columns retention-registry.ts's patterns treat as personal data, restricted to
 * types this module knows how to redact. Throws if a matched column's type is not one of those --
 * see REDACTABLE_DATA_TYPES.
 */
export async function findRedactableColumns(sql: ISql, table: string): Promise<RedactableColumn[]> {
  assertSafeIdentifier(table);
  const rows = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
    SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = ${table}
    ORDER BY column_name
  `;
  const matched = rows.filter((row) => isPersonalDataColumn(row.column_name));
  for (const row of matched) {
    if (!REDACTABLE_DATA_TYPES.has(row.data_type)) {
      throw new Error(
        `app.${table}.${row.column_name} looks like personal data (matches a PII column ` +
          `pattern) but is type "${row.data_type}", which redactPersonalColumns does not know how ` +
          `to redact. Extend REDACTABLE_DATA_TYPES in redact.ts, or exclude the column deliberately.`,
      );
    }
  }
  return matched.map((row) => ({
    columnName: row.column_name,
    isNullable: row.is_nullable === "YES",
    dataType: row.data_type,
  }));
}

function redactedValueSql(column: RedactableColumn): string {
  if (column.isNullable) return "NULL";
  // Every NOT NULL personal column verified against this schema is text/varchar (retention-
  // registry.test.ts pins the real ones); a fresh random value per row can never collide with a
  // UNIQUE constraint the way a fixed literal would, and satisfies every non-empty/no-slash CHECK
  // this schema places on one (ck_students_first_name, ck_materials_original_file_name,
  // ck_users_email/ck_users_normalized_email -- see redact.test.ts).
  return "('erased-' || gen_random_uuid()::text)";
}

/** An additional `column = value` predicate narrowing redaction to one subject within the tenant. */
export interface SubjectPredicate {
  column: string;
  value: string;
}

export interface RedactionOutcome {
  table: string;
  columns: string[];
  rowsAffected: number;
}

/**
 * Redact every personal-data-shaped column of `table`, scoped to `schoolId` and, when given, to one
 * subject within it. A matched nullable column is set to NULL; a matched NOT NULL column (e.g.
 * app.students.first_name) is set to a fresh `'erased-<uuid>'` value -- unique per row by
 * construction, so it can never collide with a UNIQUE constraint the way a fixed literal would (see
 * app.users' `uq_users_school_normalized_email`) and it satisfies every non-empty/no-slash CHECK
 * constraint this schema places on a personal-data column (verified against
 * ck_students_first_name, ck_materials_original_file_name, ck_users_email/ck_users_normalized_email
 * in redact.test.ts).
 *
 * A table with zero matching columns is a reported no-op (`columns: []`, `rowsAffected: 0`) rather
 * than an error, so a caller can run this unconditionally over every non-legal-hold,
 * non-hard-delete tenant table without first asking "does this table have anything personal on it".
 */
export async function redactPersonalColumns(
  tx: TransactionSql,
  table: string,
  schoolId: string,
  subject?: SubjectPredicate,
): Promise<RedactionOutcome> {
  assertSafeIdentifier(table);
  const columns = await findRedactableColumns(tx, table);
  if (columns.length === 0) return { table, columns: [], rowsAffected: 0 };

  const setClause = columns
    .map((column) => {
      assertSafeIdentifier(column.columnName);
      return `"${column.columnName}" = ${redactedValueSql(column)}`;
    })
    .join(", ");

  const params: string[] = [schoolId];
  let whereClause = `"school_id" = $1`;
  if (subject) {
    assertSafeIdentifier(subject.column);
    params.push(subject.value);
    whereClause += ` AND "${subject.column}" = $${params.length}`;
  }

  const result = await tx.unsafe(
    `UPDATE app."${table}" SET ${setClause} WHERE ${whereClause}`,
    params,
  );

  return {
    table,
    columns: columns.map((column) => column.columnName),
    rowsAffected: result.count,
  };
}

/**
 * Hard-delete rows of `table` for the given scope. Reserved for HARD_DELETE_TABLES
 * (retention-registry.ts) -- pure session/security artifacts with no other tenant table's foreign
 * key pointing at them, which is what makes an actual DELETE safe here when it is not safe for an
 * arbitrary tenant table (see redact.ts's and retention-registry.ts's module docs).
 */
export async function hardDeleteRows(
  tx: TransactionSql,
  table: string,
  schoolId: string,
  subject?: SubjectPredicate,
): Promise<number> {
  assertSafeIdentifier(table);
  const params: string[] = [schoolId];
  let whereClause = `"school_id" = $1`;
  if (subject) {
    assertSafeIdentifier(subject.column);
    params.push(subject.value);
    whereClause += ` AND "${subject.column}" = $${params.length}`;
  }
  const result = await tx.unsafe(`DELETE FROM app."${table}" WHERE ${whereClause}`, params);
  return result.count;
}
