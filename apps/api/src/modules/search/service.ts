/**
 * Global search (ST-278): role-scoped Postgres full-text search across students, users, invoices,
 * and materials, grouped per type.
 *
 * Each `search*` function is one independent `websearch_to_tsquery` lookup against the GIN-indexed
 * `search_tsv` column migration 000110 adds to its table, ordered by `ts_rank` and capped at
 * `limit`. Row scope is enforced by the database, not here:
 *   - app.students and app.materials already carry a `role_scope_visibility` RLS policy (000037),
 *     so a search hit is already exactly what `can_read_student` / `can_read_class` would let the
 *     caller read one row at a time.
 *   - app.users and app.invoice_cache carry only tenant isolation; which roles reach those two
 *     sections at all is decided by the route (PERMISSIONS.USER_READ / PERMISSIONS.BILLING_READ),
 *     the same gate their existing list endpoints already require.
 *
 * `globalSearch` runs only the sections the caller is permitted to see, concurrently, inside the
 * caller's own tenant transaction -- the same pipelining `openTenantTx` uses, since every query
 * shares one reserved connection regardless of `Promise.all`.
 */

import { formatMinorUnits } from "../finance/currency";

import type { userStatusSchema } from "../../openapi/components";
import type { MaterialIngestStatus } from "../academics/schemas";
import type { StudentStatus } from "../users/schemas";
import type { z } from "@hono/zod-openapi";
import type { TransactionSql } from "postgres";

/** app.users.status -- see openapi/components.ts's own doc comment on userStatusSchema. */
type UserStatus = z.infer<typeof userStatusSchema>;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 200;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudentSearchHit {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  admission_number: string;
  status: StudentStatus;
  rank: number;
}

export interface UserSearchHit {
  id: string;
  display_name: string | null;
  email: string;
  status: UserStatus;
  rank: number;
}

export interface InvoiceSearchHit {
  id: string;
  erpnext_docname: string;
  erpnext_status: string;
  total_amount: string;
  total_amount_minor: number;
  currency: string;
  student_id: string;
  /**
   * Null when the caller cannot read the linked app.students row under RLS (e.g. a FINANCE-only
   * caller, who holds neither the school-admin nor the teacher/parent relationship
   * `role_scope_visibility` checks). The invoice itself still surfaces -- see `searchInvoices`.
   */
  student_name: string | null;
  rank: number;
}

export interface MaterialSearchHit {
  id: string;
  class_id: string;
  title: string;
  description: string | null;
  ingest_status: MaterialIngestStatus;
  rank: number;
}

export interface GlobalSearchSections {
  students: boolean;
  users: boolean;
  invoices: boolean;
  materials: boolean;
}

export interface GlobalSearchResult {
  students: StudentSearchHit[];
  users: UserSearchHit[];
  invoices: InvoiceSearchHit[];
  materials: MaterialSearchHit[];
}

// ---------------------------------------------------------------------------
// Per-type queries
// ---------------------------------------------------------------------------

interface RawStudentSearchRow {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  admission_number: string;
  status: string;
  rank: number;
}

export async function searchStudents(
  tx: TransactionSql,
  schoolId: string,
  query: string,
  limit: number,
): Promise<StudentSearchHit[]> {
  const rows = await tx<RawStudentSearchRow[]>`
    SELECT
      s.id, s.first_name, s.last_name, s.preferred_name, s.admission_number, s.status::text,
      ts_rank(s.search_tsv, q.query) AS rank
    FROM app.students s, websearch_to_tsquery('simple', ${query}) AS q(query)
    WHERE s.school_id = ${schoolId}::uuid AND s.search_tsv @@ q.query
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    ...row,
    status: row.status as StudentStatus,
    rank: Number(row.rank),
  }));
}

interface RawUserSearchRow {
  id: string;
  display_name: string | null;
  email: string;
  status: string;
  rank: number;
}

export async function searchUsers(
  tx: TransactionSql,
  schoolId: string,
  query: string,
  limit: number,
): Promise<UserSearchHit[]> {
  const rows = await tx<RawUserSearchRow[]>`
    SELECT u.id, u.display_name, u.email, u.status::text, ts_rank(u.search_tsv, q.query) AS rank
    FROM app.users u, websearch_to_tsquery('simple', ${query}) AS q(query)
    WHERE u.school_id = ${schoolId}::uuid AND u.search_tsv @@ q.query
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({ ...row, status: row.status as UserStatus, rank: Number(row.rank) }));
}

interface RawInvoiceSearchRow {
  id: string;
  erpnext_docname: string;
  erpnext_status: string;
  total_amount_minor: string;
  currency_code: string;
  currency_minor_unit: number;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  student_preferred_name: string | null;
  rank: number;
}

/**
 * Matches on `erpnext_docname` alone -- never on the joined student's name -- and joins
 * app.students with `LEFT JOIN` rather than `INNER JOIN`.
 *
 * Both choices exist for the same reason: app.students carries a restrictive `role_scope_visibility`
 * policy that a FINANCE-only caller (who is neither a school admin nor related to the student) never
 * satisfies. An `INNER JOIN`, or a match condition that also tested the student's own `search_tsv`,
 * would make an invoice silently disappear from a finance user's results the moment RLS hides its
 * student row -- exactly the caller this section exists for. Matching only the invoice's own column
 * keeps "finance finds invoices" true regardless of student row-scope; the student's name is then a
 * best-effort enrichment that is simply null when RLS withholds it.
 */
export async function searchInvoices(
  tx: TransactionSql,
  schoolId: string,
  query: string,
  limit: number,
): Promise<InvoiceSearchHit[]> {
  const rows = await tx<RawInvoiceSearchRow[]>`
    SELECT
      ic.id, ic.erpnext_docname, ic.erpnext_status, ic.total_amount_minor,
      cur.code AS currency_code, cur.minor_unit AS currency_minor_unit, ic.student_id,
      s.first_name AS student_first_name, s.last_name AS student_last_name,
      s.preferred_name AS student_preferred_name,
      ts_rank(ic.search_tsv, q.query) AS rank
    FROM app.invoice_cache ic
    JOIN app.currencies cur ON cur.id = ic.currency_id
    LEFT JOIN app.students s ON s.id = ic.student_id AND s.school_id = ic.school_id
    , websearch_to_tsquery('simple', ${query}) AS q(query)
    WHERE ic.school_id = ${schoolId}::uuid AND ic.search_tsv @@ q.query
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => {
    const minor = BigInt(row.total_amount_minor);
    return {
      id: row.id,
      erpnext_docname: row.erpnext_docname,
      erpnext_status: row.erpnext_status,
      total_amount: formatMinorUnits(minor, row.currency_minor_unit),
      total_amount_minor: Number(minor),
      currency: row.currency_code,
      student_id: row.student_id,
      student_name:
        row.student_preferred_name ??
        (row.student_first_name !== null && row.student_last_name !== null
          ? `${row.student_first_name} ${row.student_last_name}`
          : null),
      rank: Number(row.rank),
    };
  });
}

interface RawMaterialSearchRow {
  id: string;
  class_id: string;
  title: string;
  description: string | null;
  ingest_status: string;
  rank: number;
}

export async function searchMaterials(
  tx: TransactionSql,
  schoolId: string,
  query: string,
  limit: number,
): Promise<MaterialSearchHit[]> {
  const rows = await tx<RawMaterialSearchRow[]>`
    SELECT
      m.id, m.class_id, m.title, m.description, m.ingest_status::text,
      ts_rank(m.search_tsv, q.query) AS rank
    FROM app.materials m, websearch_to_tsquery('english', ${query}) AS q(query)
    WHERE m.school_id = ${schoolId}::uuid AND m.search_tsv @@ q.query
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    ...row,
    ingest_status: row.ingest_status as MaterialIngestStatus,
    rank: Number(row.rank),
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs only the sections `sections` marks true, concurrently. A section the caller lacks
 * permission for comes back as an empty array rather than an error or an omitted key -- the
 * response shape never depends on the caller's role, only its contents do.
 */
export async function globalSearch(
  tx: TransactionSql,
  schoolId: string,
  query: string,
  limit: number,
  sections: GlobalSearchSections,
): Promise<GlobalSearchResult> {
  const [students, users, invoices, materials] = await Promise.all([
    sections.students ? searchStudents(tx, schoolId, query, limit) : Promise.resolve([]),
    sections.users ? searchUsers(tx, schoolId, query, limit) : Promise.resolve([]),
    sections.invoices ? searchInvoices(tx, schoolId, query, limit) : Promise.resolve([]),
    sections.materials ? searchMaterials(tx, schoolId, query, limit) : Promise.resolve([]),
  ]);

  return { students, users, invoices, materials };
}
