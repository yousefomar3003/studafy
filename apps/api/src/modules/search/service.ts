/**
 * Global search (ST-278, extended by migration 000171): role-scoped Postgres full-text search over
 * twenty record types, grouped per type, with per-type totals for paging.
 *
 * Matching. The query is normalized and split into letter/digit tokens here (./normalize.ts, the
 * same rules as `app.search_normalize`), then ANDed with the LAST token as a prefix: "oma" -> 'oma':*,
 * "omar kh" -> 'omar' & 'kh':*, "inv-00" -> 'inv' & '00':*. Tokens contain only \p{L}\p{N}, so no
 * tsquery operator can reach `to_tsquery`; the built text is still a single bound parameter, and SQL
 * runs it through `app.search_normalize` once more. Each document side is a stored generated column,
 * `to_tsvector(cfg, app.search_document(...))`, which folds punctuation the same way, so "INV-0012"
 * is stored as 'inv' and '0012' rather than 'inv' and the signed integer '-0012'.
 *
 * No search indexes. Under FORCE RLS PostgreSQL will not use an index for `@@` or `<%` (neither is
 * LEAKPROOF, so neither can run before the policy quals), so migration 000171 creates none: every
 * section's scan is bounded by the tenant's school_id btree and the match is a filter over that
 * school's rows (000171, header point 4).
 *
 * Typo fallback. A section that has a trigram `search_name` (students, users, classes, subjects,
 * families) can run again as a pg_trgm word-similarity match (`<%`) of the normalized query against
 * the normalized name, with a floor of SEARCH_TRIGRAM_FLOOR -- see its doc comment for the number.
 * When it runs depends on the section:
 *   - tenant-only sections (users, families): when full-text found nothing. Their full-text result
 *     is already the school-wide answer.
 *   - RLS-scoped sections (students, classes, subjects): only when full-text found no candidate in
 *     the whole school, i.e. `app.search_scoped_ids` returned nothing. A name that exists but sits
 *     outside the caller's row scope is not a typo: the caller gets an empty section, without the
 *     fallback paying the per-row policy predicate for every similar name in the school. The
 *     "any candidate" flag comes back in the same statement as the page (`has_candidates`), so
 *     the rule costs no extra round trip. The flag itself is never returned to the client; the
 *     only thing it changes is whether the fallback runs (see `runSection`).
 *
 * Row scope is enforced by the database, never here:
 *   - Every query runs as studafy_app inside the caller's tenant transaction, so tenant_isolation and
 *     every role_scope_visibility / owner policy apply to each row returned and each row counted.
 *   - students, classes, subjects and materials carry a per-row SECURITY DEFINER policy predicate.
 *     To keep that predicate from running for every row in the school, those sections first ask
 *     `app.search_scoped_ids` / `app.search_scoped_fuzzy_ids` for the ids of this school's matching
 *     rows (ids only) and then read those rows as studafy_app with the same match repeated -- RLS
 *     still decides which of them come back and are counted (migration 000171, header point 6).
 *     Each candidate is read through `CROSS JOIN LATERAL (... WHERE x.id = c.id ... OFFSET 0)`: the
 *     OFFSET 0 keeps the planner from flattening it into a hash join that scans the whole table, which
 *     on a small table (16 subjects) it otherwise prefers -- and that would evaluate the per-row
 *     policy predicate, ~6 ms each for a teacher, for every row instead of every candidate.
 *   - Tables that carry only tenant isolation (users, invoice_cache, sections, grade_levels,
 *     academic_years, terms, rooms, families, announcements, school_events, discipline_incidents,
 *     fee_structure_cache, scholarships, expense_cache) are gated per section by the route, using
 *     the permission each type's own list endpoint requires, plus the same SQL narrowing that
 *     endpoint applies (families: a parent's own; evaluations: a teacher's own shared ones).
 *
 * Never searched or returned: the school-defined record tables (template answers and documents),
 * bodies, descriptions, narratives, payloads, storage keys -- anything beyond a display name, a short
 * secondary field, and the ids a link needs.
 *
 * `globalSearch` runs the requested and permitted sections concurrently inside one transaction: the
 * queries pipeline over the transaction's single reserved connection, as `openTenantTx` does.
 */

import { formatMinorUnits } from "../finance/currency";

import { searchTokens } from "./normalize";

import type { userStatusSchema } from "../../openapi/components";
import type {
  AcademicYearStatus,
  CatalogStatus,
  ClassStatus,
  MaterialIngestStatus,
  RoomType,
} from "../academics/schemas";
import type {
  DisciplineIncidentStatus,
  DisciplineIncidentType,
  DisciplineSeverity,
} from "../discipline/schemas";
import type { StudentStatus } from "../users/schemas";
import type { z } from "@hono/zod-openapi";
import type { PendingQuery, Row, TransactionSql } from "postgres";

/** app.users.status -- see openapi/components.ts's own doc comment on userStatusSchema. */
type UserStatus = z.infer<typeof userStatusSchema>;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 200;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;
/** Paging one type on a full results page; past this, refine the query instead. */
export const SEARCH_MAX_OFFSET = 1_000;
/** Tokens beyond this are ignored: a longer query is a paste, not a search. */
export const SEARCH_MAX_TOKENS = 8;

/**
 * pg_trgm word-similarity floor for the typo fallback: the share of the query's trigrams that must
 * appear in some word run of the name. 0.5 keeps one wrong, missing or doubled letter in a name of
 * five letters or more ("fatma" -> Fatima 0.50, "yusef" -> Yusuf 0.50, "khalid" -> Khaled 0.57,
 * "hasan" -> Hassan 0.63, "mohamed" -> Mohammed 0.70, "ahmd" -> Ahmed 0.60). It deliberately drops
 * a swapped letter in a four-letter name ("jonh" -> John 0.40): a four-letter query has five
 * trigrams, two of which only encode its first two letters, so at 0.40 "math" also matches every
 * Mariam and Maya -- noise, and on a large school hundreds of candidates for the row-level checks.
 * The fallback only runs when full-text matching found nothing in that section -- and, for an
 * RLS-scoped section, no candidate anywhere in the school (see the file header).
 */
export const SEARCH_TRIGRAM_FLOOR = 0.5;

export const SEARCH_TYPES = [
  "students",
  "users",
  "invoices",
  "materials",
  "classes",
  "sections",
  "subjects",
  "grade_levels",
  "academic_years",
  "terms",
  "rooms",
  "families",
  "announcements",
  "events",
  "incidents",
  "evaluations",
  "fee_structures",
  "scholarships",
  "expenses",
  "notifications",
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

export interface SearchTerms {
  /** `to_tsquery` text: tokens ANDed, last one a prefix. Only letters, digits, `&`, `:*`, spaces. */
  tsquery: string;
  /** The normalized tokens joined by spaces, for trigram matching. */
  fuzzy: string;
}

/** Null when the query has no letter or digit at all -- nothing can match, so nothing is run. */
export function buildSearchTerms(query: string): SearchTerms | null {
  const tokens = searchTokens(query).slice(0, SEARCH_MAX_TOKENS);
  if (tokens.length === 0) return null;
  const tsquery = tokens
    .map((token, index) => (index === tokens.length - 1 ? `${token}:*` : token))
    .join(" & ");
  return { tsquery, fuzzy: tokens.join(" ") };
}

// ---------------------------------------------------------------------------
// Hit types
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
  email: string | null;
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
  /** Null when RLS withholds the linked student from the caller -- see `searchInvoices`. */
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

export interface ClassSearchHit {
  id: string;
  code: string;
  course_id: string;
  course_name: string | null;
  status: ClassStatus;
  academic_year_id: string;
  term_id: string;
  section_id: string | null;
  rank: number;
}

export interface SectionSearchHit {
  id: string;
  name: string;
  grade_level_id: string;
  grade_level_name: string;
  academic_year_id: string;
  archived: boolean;
  rank: number;
}

export interface SubjectSearchHit {
  id: string;
  code: string;
  name: string;
  status: CatalogStatus;
  rank: number;
}

export interface GradeLevelSearchHit {
  id: string;
  name: string;
  archived: boolean;
  rank: number;
}

export interface AcademicYearSearchHit {
  id: string;
  code: string;
  name: string;
  status: AcademicYearStatus;
  starts_on: string;
  ends_on: string;
  rank: number;
}

export interface TermSearchHit {
  id: string;
  code: string;
  name: string;
  academic_year_id: string;
  academic_year_name: string;
  status: AcademicYearStatus;
  starts_on: string;
  ends_on: string;
  rank: number;
}

export interface RoomSearchHit {
  id: string;
  code: string;
  name: string;
  building: string | null;
  room_type: RoomType;
  is_active: boolean;
  rank: number;
}

export interface FamilySearchHit {
  id: string;
  display_name: string;
  primary_parent_user_id: string;
  /** Best-effort enrichment; null if the parent's user row is not readable. */
  primary_parent_name: string | null;
  rank: number;
}

export interface AnnouncementSearchHit {
  id: string;
  title: string;
  status: "scheduled" | "published";
  audience_type: "school" | "role" | "class";
  scheduled_at: string;
  published_at: string | null;
  rank: number;
}

export interface EventSearchHit {
  id: string;
  title: string;
  kind: "holiday" | "event" | "meeting" | "exam_period";
  starts_on: string;
  ends_on: string;
  rank: number;
}

export interface IncidentSearchHit {
  id: string;
  title: string;
  incident_type: DisciplineIncidentType;
  severity: DisciplineSeverity;
  status: DisciplineIncidentStatus;
  incident_at: string;
  student_id: string;
  student_name: string | null;
  class_id: string | null;
  rank: number;
}

export interface EvaluationSearchHit {
  id: string;
  teacher_id: string;
  teacher_user_id: string;
  teacher_name: string | null;
  evaluation_type: string;
  status: string;
  evaluated_at: string;
  class_id: string | null;
  rank: number;
}

export interface FeeStructureSearchHit {
  id: string;
  title: string;
  erpnext_name: string;
  erpnext_status: string;
  is_active: boolean;
  total_amount: string;
  total_amount_minor: number;
  currency: string;
  academic_year_id: string | null;
  academic_year_name: string | null;
  rank: number;
}

export interface ScholarshipSearchHit {
  id: string;
  name: string;
  discount_type: "percentage" | "fixed";
  percentage: string | null;
  amount: string | null;
  amount_minor: number | null;
  currency: string | null;
  fee_category: string | null;
  is_active: boolean;
  rank: number;
}

export interface ExpenseSearchHit {
  id: string;
  vendor: string;
  category: string;
  document_type: string;
  erpnext_docname: string;
  erpnext_status: string;
  amount: string;
  amount_minor: number;
  currency: string;
  expense_date: string;
  rank: number;
}

export interface NotificationSearchHit {
  id: string;
  title: string;
  notification_type: string;
  read_at: string | null;
  created_at: string;
  rank: number;
}

export interface GlobalSearchResult {
  students: StudentSearchHit[];
  users: UserSearchHit[];
  invoices: InvoiceSearchHit[];
  materials: MaterialSearchHit[];
  classes: ClassSearchHit[];
  sections: SectionSearchHit[];
  subjects: SubjectSearchHit[];
  grade_levels: GradeLevelSearchHit[];
  academic_years: AcademicYearSearchHit[];
  terms: TermSearchHit[];
  rooms: RoomSearchHit[];
  families: FamilySearchHit[];
  announcements: AnnouncementSearchHit[];
  events: EventSearchHit[];
  incidents: IncidentSearchHit[];
  evaluations: EvaluationSearchHit[];
  fee_structures: FeeStructureSearchHit[];
  scholarships: ScholarshipSearchHit[];
  expenses: ExpenseSearchHit[];
  notifications: NotificationSearchHit[];
}

export type GlobalSearchTotals = Record<SearchType, number>;

/** Which sections the caller may see, and the per-section narrowing their list endpoints apply. */
export interface GlobalSearchAccess {
  sections: Record<SearchType, boolean>;
  /** GET /api/families without parent:link: only families the caller heads or belongs to. */
  familiesOwnOnly: boolean;
  /** GET /api/evaluations for an INSTRUCTOR: only their own evaluations shared with them. */
  evaluationsOwnSharedOnly: boolean;
}

// ---------------------------------------------------------------------------
// Section plumbing
// ---------------------------------------------------------------------------

type MatchMode = "fts" | "fuzzy";

interface SectionContext {
  tx: TransactionSql;
  schoolId: string;
  userId: string;
  terms: SearchTerms;
  access: GlobalSearchAccess;
}

/** Every section query also selects `count(*) OVER ()::int AS total_count`. */
interface Counted {
  total_count: number;
}

/**
 * RLS-scoped full-text queries (students, classes, subjects) also report whether
 * `app.search_scoped_ids` found any candidate in the school. They always return at least one row:
 * when no hit is visible to the caller, a single sentinel row whose hit columns (`id` included) are
 * all null carries the flag. `runSection` drops that row.
 */
interface CandidateFlag {
  has_candidates?: boolean | null;
}

type SectionQuery<R extends Row> = (
  context: SectionContext,
  mode: MatchMode,
  limit: number,
  offset: number,
) => PendingQuery<(R & Counted & CandidateFlag)[]>;

interface SectionPage<R> {
  rows: R[];
  total: number;
}

/** Hit rows only: drops the sentinel row a scoped full-text query returns when nothing is visible. */
function hits<R extends Row>(rows: readonly (R & Counted & CandidateFlag)[]): (R & Counted)[] {
  return rows.filter((row) => row.id !== null);
}

/**
 * One section: full-text first, then -- if the section has a trigram column -- the typo fallback,
 * when full-text matched nothing the caller can see AND (for an RLS-scoped section) the school has
 * no full-text candidate at all (`has_candidates` false; see the header). `count(*) OVER ()` gives
 * the total alongside the page; a page past the end has no hit row to carry it, so the total is then
 * read from a one-row probe.
 */
async function runSection<R extends Row>(
  context: SectionContext,
  query: SectionQuery<R>,
  limit: number,
  offset: number,
  fuzzy: boolean,
): Promise<SectionPage<R & Counted>> {
  const modes: MatchMode[] = fuzzy ? ["fts", "fuzzy"] : ["fts"];
  for (const mode of modes) {
    const raw = await query(context, mode, limit, offset);
    const rows = hits(raw);
    let total = rows[0]?.total_count ?? 0;
    if (rows.length === 0 && offset > 0) {
      const probe = hits(await query(context, mode, 1, 0));
      total = probe[0]?.total_count ?? 0;
    }
    if (total > 0) return { rows, total };
    // A scoped section whose full-text query has candidates the caller cannot see: not a typo.
    if (raw[0]?.has_candidates === true) break;
  }
  return { rows: [], total: 0 };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function personName(
  preferred: string | null,
  first: string | null,
  last: string | null,
): string | null {
  if (preferred !== null && preferred.length > 0) return preferred;
  if (first !== null && last !== null) return `${first} ${last}`;
  return null;
}

// ---------------------------------------------------------------------------
// Per-type queries: people and finance documents (the original four)
// ---------------------------------------------------------------------------

interface RawStudentRow {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  admission_number: string;
  status: string;
  rank: number;
}

/** app.students: role_scope_visibility (can_read_student) narrows rows; scoped candidates first. */
const studentQuery: SectionQuery<RawStudentRow> = ({ tx, schoolId, terms }, mode, limit, offset) =>
  mode === "fts"
    ? tx<(RawStudentRow & Counted & CandidateFlag)[]>`
        WITH q AS MATERIALIZED (
          SELECT to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS query
        ),
        c AS MATERIALIZED (
          SELECT c.id FROM q CROSS JOIN LATERAL app.search_scoped_ids('students', q.query) AS c(id)
        ),
        page AS (
          SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.admission_number,
                 s.status::text AS status, ts_rank(s.search_tsv, q.query) AS rank,
                 count(*) OVER ()::int AS total_count
          FROM q CROSS JOIN c
          CROSS JOIN LATERAL (
            SELECT * FROM app.students x
            WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid AND x.search_tsv @@ q.query
            OFFSET 0
          ) s
          ORDER BY rank DESC, s.last_name, s.id
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT p.*, EXISTS (SELECT 1 FROM c) AS has_candidates
        FROM (VALUES (1)) AS one (x) LEFT JOIN page AS p ON true
        ORDER BY p.rank DESC, p.last_name, p.id
      `
    : tx<(RawStudentRow & Counted)[]>`
        SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.admission_number,
               s.status::text, word_similarity(q.needle, s.search_name) AS rank,
               count(*) OVER ()::int AS total_count
        FROM app.search_normalize(${terms.fuzzy}) AS q(needle)
        CROSS JOIN LATERAL app.search_scoped_fuzzy_ids('students', q.needle) AS c(id)
        CROSS JOIN LATERAL (
          SELECT * FROM app.students x
          WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid AND q.needle <% x.search_name
          OFFSET 0
        ) s
        ORDER BY rank DESC, s.last_name, s.id
        LIMIT ${limit} OFFSET ${offset}
      `;

interface RawUserRow {
  id: string;
  display_name: string | null;
  email: string | null;
  status: string;
  rank: number;
}

/** app.users: tenant isolation only; the route gates the section on user:read. */
const userQuery: SectionQuery<RawUserRow> = ({ tx, schoolId, terms }, mode, limit, offset) =>
  mode === "fts"
    ? tx<(RawUserRow & Counted)[]>`
        SELECT u.id, u.display_name, u.email, u.status::text, ts_rank(u.search_tsv, q.query) AS rank,
               count(*) OVER ()::int AS total_count
        FROM app.users u, to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
        WHERE u.school_id = ${schoolId}::uuid AND u.search_tsv @@ q.query
        ORDER BY rank DESC, u.display_name, u.id
        LIMIT ${limit} OFFSET ${offset}
      `
    : tx<(RawUserRow & Counted)[]>`
        SELECT u.id, u.display_name, u.email, u.status::text,
               word_similarity(q.needle, u.search_name) AS rank, count(*) OVER ()::int AS total_count
        FROM app.users u, app.search_normalize(${terms.fuzzy}) AS q(needle)
        WHERE u.school_id = ${schoolId}::uuid AND q.needle <% u.search_name
        ORDER BY rank DESC, u.display_name, u.id
        LIMIT ${limit} OFFSET ${offset}
      `;

interface RawInvoiceRow {
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
 * Matches on the invoice's own number alone -- never on the joined student's name -- and joins
 * app.students with `LEFT JOIN`. app.students' restrictive role_scope_visibility policy hides every
 * student from a FINANCE-only caller, so an `INNER JOIN` or a match on the student's name would make
 * invoices vanish for exactly the caller this section exists for. The student's name is a
 * best-effort enrichment that is null when RLS withholds it.
 */
const invoiceQuery: SectionQuery<RawInvoiceRow> = ({ tx, schoolId, terms }, _mode, limit, offset) =>
  tx<(RawInvoiceRow & Counted)[]>`
    SELECT
      ic.id, ic.erpnext_docname, ic.erpnext_status, ic.total_amount_minor,
      cur.code AS currency_code, cur.minor_unit AS currency_minor_unit, ic.student_id,
      s.first_name AS student_first_name, s.last_name AS student_last_name,
      s.preferred_name AS student_preferred_name,
      ts_rank(ic.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.invoice_cache ic
    JOIN app.currencies cur ON cur.id = ic.currency_id
    LEFT JOIN app.students s ON s.id = ic.student_id AND s.school_id = ic.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE ic.school_id = ${schoolId}::uuid AND ic.search_tsv @@ q.query
    ORDER BY rank DESC, ic.erpnext_docname, ic.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawMaterialRow {
  id: string;
  class_id: string;
  title: string;
  description: string | null;
  ingest_status: string;
  rank: number;
}

/** app.materials: role_scope_visibility (can_read_class(class_id)); 'english' -- titles are prose. */
const materialQuery: SectionQuery<RawMaterialRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawMaterialRow & Counted)[]>`
    SELECT m.id, m.class_id, m.title, m.description, m.ingest_status::text,
           ts_rank(m.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM to_tsquery('english', app.search_normalize(${terms.tsquery})) AS q(query)
    CROSS JOIN LATERAL app.search_scoped_ids('materials', q.query) AS c(id)
    CROSS JOIN LATERAL (
      SELECT * FROM app.materials x
      WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid AND x.search_tsv @@ q.query
      OFFSET 0
    ) m
    ORDER BY rank DESC, m.title, m.id
    LIMIT ${limit} OFFSET ${offset}
  `;

// ---------------------------------------------------------------------------
// Per-type queries: academic structure (GET /api/academics/* -- open to every school member)
// ---------------------------------------------------------------------------

interface RawClassRow {
  id: string;
  code: string;
  course_id: string;
  course_name: string | null;
  status: string;
  academic_year_id: string;
  term_id: string;
  section_id: string | null;
  rank: number;
}

/**
 * app.classes: role_scope_visibility (can_read_class) narrows a teacher to the classes they teach, a
 * student or parent to enrolled classes. Matches the class code plus its course's code and name; a
 * readable class always has a readable course (can_read_course admits any course with a readable
 * class), so the LEFT JOIN only guards against a missing row.
 */
const classQuery: SectionQuery<RawClassRow> = ({ tx, schoolId, terms }, mode, limit, offset) =>
  mode === "fts"
    ? tx<(RawClassRow & Counted & CandidateFlag)[]>`
        WITH q AS MATERIALIZED (
          SELECT to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS query
        ),
        c AS MATERIALIZED (
          SELECT c.id FROM q CROSS JOIN LATERAL app.search_scoped_ids('classes', q.query) AS c(id)
        ),
        page AS (
          SELECT cl.id, cl.code, cl.course_id, co.name AS course_name, cl.status::text AS status,
                 cl.academic_year_id, cl.term_id, cl.section_id,
                 ts_rank(cl.search_tsv || coalesce(co.search_tsv, ''::tsvector), q.query) AS rank,
                 count(*) OVER ()::int AS total_count
          FROM q CROSS JOIN c
          CROSS JOIN LATERAL (
            SELECT * FROM app.classes x WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid OFFSET 0
          ) cl
          LEFT JOIN LATERAL (
            SELECT * FROM app.courses y
            WHERE y.id = cl.course_id AND y.school_id = cl.school_id
            OFFSET 0
          ) co ON true
          WHERE (cl.search_tsv || coalesce(co.search_tsv, ''::tsvector)) @@ q.query
          ORDER BY rank DESC, cl.code, cl.id
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT p.*, EXISTS (SELECT 1 FROM c) AS has_candidates
        FROM (VALUES (1)) AS one (x) LEFT JOIN page AS p ON true
        ORDER BY p.rank DESC, p.code, p.id
      `
    : tx<(RawClassRow & Counted)[]>`
        SELECT cl.id, cl.code, cl.course_id, co.name AS course_name, cl.status::text,
               cl.academic_year_id, cl.term_id, cl.section_id,
               word_similarity(q.needle, cl.search_name) AS rank, count(*) OVER ()::int AS total_count
        FROM app.search_normalize(${terms.fuzzy}) AS q(needle)
        CROSS JOIN LATERAL app.search_scoped_fuzzy_ids('classes', q.needle) AS c(id)
        CROSS JOIN LATERAL (
          SELECT * FROM app.classes x
          WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid AND q.needle <% x.search_name
          OFFSET 0
        ) cl
        LEFT JOIN LATERAL (
          SELECT * FROM app.courses y
          WHERE y.id = cl.course_id AND y.school_id = cl.school_id
          OFFSET 0
        ) co ON true
        ORDER BY rank DESC, cl.code, cl.id
        LIMIT ${limit} OFFSET ${offset}
      `;

interface RawSectionRow {
  id: string;
  name: string;
  grade_level_id: string;
  grade_level_name: string;
  academic_year_id: string;
  archived: boolean;
  rank: number;
}

/** app.sections + app.grade_levels: tenant isolation only. "Grade 10 C" matches across both names. */
const sectionQuery: SectionQuery<RawSectionRow> = ({ tx, schoolId, terms }, _mode, limit, offset) =>
  tx<(RawSectionRow & Counted)[]>`
    SELECT s.id, s.name, s.grade_level_id, g.name AS grade_level_name, s.academic_year_id,
           s.archived_at IS NOT NULL AS archived,
           ts_rank(s.search_tsv || g.search_tsv, q.query) AS rank,
           count(*) OVER ()::int AS total_count
    FROM app.sections s
    JOIN app.grade_levels g ON g.id = s.grade_level_id AND g.school_id = s.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE s.school_id = ${schoolId}::uuid AND (s.search_tsv || g.search_tsv) @@ q.query
    ORDER BY rank DESC, g.sort_order, s.name, s.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawSubjectRow {
  id: string;
  code: string;
  name: string;
  status: string;
  rank: number;
}

/** app.subjects: role_scope_visibility (can_read_subject); scoped candidates first. */
const subjectQuery: SectionQuery<RawSubjectRow> = ({ tx, schoolId, terms }, mode, limit, offset) =>
  mode === "fts"
    ? tx<(RawSubjectRow & Counted & CandidateFlag)[]>`
        WITH q AS MATERIALIZED (
          SELECT to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS query
        ),
        c AS MATERIALIZED (
          SELECT c.id FROM q CROSS JOIN LATERAL app.search_scoped_ids('subjects', q.query) AS c(id)
        ),
        page AS (
          SELECT su.id, su.code, su.name, su.status::text AS status,
                 ts_rank(su.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
          FROM q CROSS JOIN c
          CROSS JOIN LATERAL (
            SELECT * FROM app.subjects x
            WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid AND x.search_tsv @@ q.query
            OFFSET 0
          ) su
          ORDER BY rank DESC, su.code, su.id
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT p.*, EXISTS (SELECT 1 FROM c) AS has_candidates
        FROM (VALUES (1)) AS one (x) LEFT JOIN page AS p ON true
        ORDER BY p.rank DESC, p.code, p.id
      `
    : tx<(RawSubjectRow & Counted)[]>`
        SELECT su.id, su.code, su.name, su.status::text,
               word_similarity(q.needle, su.search_name) AS rank, count(*) OVER ()::int AS total_count
        FROM app.search_normalize(${terms.fuzzy}) AS q(needle)
        CROSS JOIN LATERAL app.search_scoped_fuzzy_ids('subjects', q.needle) AS c(id)
        CROSS JOIN LATERAL (
          SELECT * FROM app.subjects x
          WHERE x.id = c.id AND x.school_id = ${schoolId}::uuid AND q.needle <% x.search_name
          OFFSET 0
        ) su
        ORDER BY rank DESC, su.code, su.id
        LIMIT ${limit} OFFSET ${offset}
      `;

interface RawGradeLevelRow {
  id: string;
  name: string;
  archived: boolean;
  rank: number;
}

const gradeLevelQuery: SectionQuery<RawGradeLevelRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawGradeLevelRow & Counted)[]>`
    SELECT g.id, g.name, g.archived_at IS NOT NULL AS archived,
           ts_rank(g.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.grade_levels g, to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE g.school_id = ${schoolId}::uuid AND g.search_tsv @@ q.query
    ORDER BY rank DESC, g.sort_order, g.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawAcademicYearRow {
  id: string;
  code: string;
  name: string;
  status: string;
  starts_on: string;
  ends_on: string;
  rank: number;
}

const academicYearQuery: SectionQuery<RawAcademicYearRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawAcademicYearRow & Counted)[]>`
    SELECT y.id, y.code, y.name, y.status::text, y.starts_on::text, y.ends_on::text,
           ts_rank(y.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.academic_years y,
         to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE y.school_id = ${schoolId}::uuid AND y.search_tsv @@ q.query
    ORDER BY rank DESC, y.starts_on DESC, y.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawTermRow {
  id: string;
  code: string;
  name: string;
  academic_year_id: string;
  academic_year_name: string;
  status: string;
  starts_on: string;
  ends_on: string;
  rank: number;
}

const termQuery: SectionQuery<RawTermRow> = ({ tx, schoolId, terms }, _mode, limit, offset) =>
  tx<(RawTermRow & Counted)[]>`
    SELECT t.id, t.code, t.name, t.academic_year_id, y.name AS academic_year_name, t.status::text,
           t.starts_on::text, t.ends_on::text, ts_rank(t.search_tsv, q.query) AS rank,
           count(*) OVER ()::int AS total_count
    FROM app.terms t
    JOIN app.academic_years y ON y.id = t.academic_year_id AND y.school_id = t.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE t.school_id = ${schoolId}::uuid AND t.search_tsv @@ q.query
    ORDER BY rank DESC, t.starts_on DESC, t.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawRoomRow {
  id: string;
  code: string;
  name: string;
  building: string | null;
  room_type: string;
  is_active: boolean;
  rank: number;
}

const roomQuery: SectionQuery<RawRoomRow> = ({ tx, schoolId, terms }, _mode, limit, offset) =>
  tx<(RawRoomRow & Counted)[]>`
    SELECT r.id, r.code, r.name, r.building, r.room_type::text, r.is_active,
           ts_rank(r.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.rooms r, to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE r.school_id = ${schoolId}::uuid AND r.search_tsv @@ q.query
    ORDER BY rank DESC, r.code, r.id
    LIMIT ${limit} OFFSET ${offset}
  `;

// ---------------------------------------------------------------------------
// Per-type queries: families, communication, leadership, finance setup, own inbox
// ---------------------------------------------------------------------------

interface RawFamilyRow {
  id: string;
  display_name: string;
  primary_parent_user_id: string;
  primary_parent_name: string | null;
  rank: number;
}

/**
 * app.families: tenant isolation only. Matches the family's own display name alone, like invoices
 * match only their own number: finance reaches this section through billing:read and must find a
 * family regardless of which children or guardians RLS would let it read. The primary parent's name
 * is a best-effort LEFT JOIN enrichment. A caller without parent:link or billing:read (a PARENT) is
 * narrowed exactly as GET /api/families narrows them: families they head or are linked into.
 */
const familyQuery: SectionQuery<RawFamilyRow> = (
  { tx, schoolId, userId, terms, access },
  mode,
  limit,
  offset,
) => {
  const ownOnly = access.familiesOwnOnly
    ? tx`
        AND (
          f.primary_parent_user_id = ${userId}::uuid
          OR EXISTS (
            SELECT 1 FROM app.parent_child_links link
            WHERE link.school_id = f.school_id AND link.family_id = f.id
              AND link.parent_user_id = ${userId}::uuid
          )
        )
      `
    : tx``;
  return mode === "fts"
    ? tx<(RawFamilyRow & Counted)[]>`
        SELECT f.id, f.display_name, f.primary_parent_user_id,
               p.display_name AS primary_parent_name,
               ts_rank(f.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
        FROM app.families f
        LEFT JOIN app.users p ON p.id = f.primary_parent_user_id AND p.school_id = f.school_id
        CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
        WHERE f.school_id = ${schoolId}::uuid AND f.search_tsv @@ q.query ${ownOnly}
        ORDER BY rank DESC, f.display_name, f.id
        LIMIT ${limit} OFFSET ${offset}
      `
    : tx<(RawFamilyRow & Counted)[]>`
        SELECT f.id, f.display_name, f.primary_parent_user_id,
               p.display_name AS primary_parent_name,
               word_similarity(q.needle, f.search_name) AS rank, count(*) OVER ()::int AS total_count
        FROM app.families f
        LEFT JOIN app.users p ON p.id = f.primary_parent_user_id AND p.school_id = f.school_id
        CROSS JOIN app.search_normalize(${terms.fuzzy}) AS q(needle)
        WHERE f.school_id = ${schoolId}::uuid AND q.needle <% f.search_name ${ownOnly}
        ORDER BY rank DESC, f.display_name, f.id
        LIMIT ${limit} OFFSET ${offset}
      `;
};

interface RawAnnouncementRow {
  id: string;
  title: string;
  status: string;
  audience_type: string;
  scheduled_at: Date;
  published_at: Date | null;
  rank: number;
}

/** app.announcements: tenant isolation only; notification:manage reads the school's history. */
const announcementQuery: SectionQuery<RawAnnouncementRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawAnnouncementRow & Counted)[]>`
    SELECT a.id, a.title, a.status, a.audience_type, a.scheduled_at, a.published_at,
           ts_rank(a.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.announcements a,
         to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE a.school_id = ${schoolId}::uuid AND a.search_tsv @@ q.query
    ORDER BY rank DESC, a.scheduled_at DESC, a.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawEventRow {
  id: string;
  title: string;
  kind: string;
  starts_on: string;
  ends_on: string;
  rank: number;
}

/** app.school_events: tenant isolation only, no audience column; calendarEvent:read. */
const eventQuery: SectionQuery<RawEventRow> = ({ tx, schoolId, terms }, _mode, limit, offset) =>
  tx<(RawEventRow & Counted)[]>`
    SELECT e.id, e.title, e.kind, e.starts_on::text, e.ends_on::text,
           ts_rank(e.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.school_events e,
         to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE e.school_id = ${schoolId}::uuid AND e.search_tsv @@ q.query
    ORDER BY rank DESC, e.starts_on DESC, e.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawIncidentRow {
  id: string;
  title: string;
  incident_type: string;
  severity: string;
  status: string;
  incident_at: Date;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  student_preferred_name: string | null;
  class_id: string | null;
  rank: number;
}

/**
 * app.discipline_incidents: tenant isolation only; the route admits school leadership alone (see
 * routes.ts). Matches the incident title only -- the description is never searched or returned.
 */
const incidentQuery: SectionQuery<RawIncidentRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawIncidentRow & Counted)[]>`
    SELECT i.id, i.title, i.incident_type::text, i.severity::text, i.status::text, i.incident_at,
           i.student_id, s.first_name AS student_first_name, s.last_name AS student_last_name,
           s.preferred_name AS student_preferred_name, i.class_id,
           ts_rank(i.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.discipline_incidents i
    LEFT JOIN app.students s ON s.id = i.student_id AND s.school_id = i.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE i.school_id = ${schoolId}::uuid AND i.search_tsv @@ q.query
    ORDER BY rank DESC, i.incident_at DESC, i.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawEvaluationRow {
  id: string;
  teacher_id: string;
  teacher_user_id: string;
  teacher_name: string | null;
  evaluation_type: string;
  status: string;
  evaluated_at: Date;
  class_id: string | null;
  rank: number;
}

/**
 * app.teacher_evaluations has no free text of its own that is not the evaluator's narrative, so an
 * evaluation is found by the evaluated teacher's name (their app.users.search_tsv). Its restrictive
 * teacher_evaluation_visibility policy already limits rows to evaluations the caller authored or
 * that were shared with them; an INSTRUCTOR is further narrowed exactly as GET /api/evaluations does.
 */
const evaluationQuery: SectionQuery<RawEvaluationRow> = (
  { tx, schoolId, userId, terms, access },
  _mode,
  limit,
  offset,
) => {
  const ownSharedOnly = access.evaluationsOwnSharedOnly
    ? tx`
        AND e.teacher_id IN (
          SELECT id FROM app.teachers WHERE user_id = ${userId}::uuid AND school_id = ${schoolId}::uuid
        )
        AND e.shared_with_teacher = true
      `
    : tx``;
  return tx<(RawEvaluationRow & Counted)[]>`
    SELECT e.id, e.teacher_id, t.user_id AS teacher_user_id, u.display_name AS teacher_name,
           e.evaluation_type::text, e.status::text, e.evaluated_at, e.class_id,
           ts_rank(u.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.teacher_evaluations e
    JOIN app.teachers t ON t.id = e.teacher_id AND t.school_id = e.school_id
    JOIN app.users u ON u.id = t.user_id AND u.school_id = t.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE e.school_id = ${schoolId}::uuid AND u.search_tsv @@ q.query ${ownSharedOnly}
    ORDER BY rank DESC, e.evaluated_at DESC, e.id
    LIMIT ${limit} OFFSET ${offset}
  `;
};

interface RawFeeStructureRow {
  id: string;
  title: string;
  erpnext_docname: string;
  erpnext_status: string;
  is_active: boolean;
  total_amount_minor: string;
  currency_code: string;
  currency_minor_unit: number;
  academic_year_id: string | null;
  academic_year_name: string | null;
  rank: number;
}

/**
 * app.fee_structure_cache: tenant isolation only; billing:update, as GET /api/finance/fee-structures.
 * Matches the structure's own title, number and program only; the academic year's name is a
 * best-effort LEFT JOIN enrichment (the year may be unset).
 */
const feeStructureQuery: SectionQuery<RawFeeStructureRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawFeeStructureRow & Counted)[]>`
    SELECT fs.id, fs.title, fs.erpnext_docname, fs.erpnext_status, fs.is_active,
           fs.total_amount_minor, cur.code AS currency_code, cur.minor_unit AS currency_minor_unit,
           fs.academic_year_id, y.name AS academic_year_name,
           ts_rank(fs.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.fee_structure_cache fs
    JOIN app.currencies cur ON cur.id = fs.currency_id
    LEFT JOIN app.academic_years y ON y.id = fs.academic_year_id AND y.school_id = fs.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE fs.school_id = ${schoolId}::uuid AND fs.search_tsv @@ q.query
    ORDER BY rank DESC, fs.title, fs.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawScholarshipRow {
  id: string;
  name: string;
  discount_type: string;
  percentage: string | null;
  amount_minor: string | null;
  currency_code: string | null;
  currency_minor_unit: number | null;
  fee_category: string | null;
  is_active: boolean;
  rank: number;
}

/** app.scholarships: tenant isolation only; billing:read, as GET /api/finance/scholarships. */
const scholarshipQuery: SectionQuery<RawScholarshipRow> = (
  { tx, schoolId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawScholarshipRow & Counted)[]>`
    SELECT sc.id, sc.name, sc.discount_type, sc.percentage::text, sc.amount_minor,
           cur.code AS currency_code, cur.minor_unit AS currency_minor_unit, sc.fee_category,
           sc.is_active, ts_rank(sc.search_tsv, q.query) AS rank,
           count(*) OVER ()::int AS total_count
    FROM app.scholarships sc
    LEFT JOIN app.currencies cur ON cur.id = sc.currency_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE sc.school_id = ${schoolId}::uuid AND sc.search_tsv @@ q.query
    ORDER BY rank DESC, sc.name, sc.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawExpenseRow {
  id: string;
  vendor: string;
  category: string;
  document_type: string;
  erpnext_docname: string;
  erpnext_status: string;
  amount_minor: string;
  currency_code: string;
  currency_minor_unit: number;
  expense_date: string;
  rank: number;
}

/**
 * app.expense_cache: tenant isolation only; billing:update, as GET /api/finance/expenses. Never
 * selects the attachment storage key, the description, or the ERPNext payload.
 */
const expenseQuery: SectionQuery<RawExpenseRow> = ({ tx, schoolId, terms }, _mode, limit, offset) =>
  tx<(RawExpenseRow & Counted)[]>`
    SELECT ex.id, ex.vendor, ex.category, ex.document_type, ex.erpnext_docname, ex.erpnext_status,
           ex.amount_minor, cur.code AS currency_code, cur.minor_unit AS currency_minor_unit,
           ex.expense_date::text, ts_rank(ex.search_tsv, q.query) AS rank,
           count(*) OVER ()::int AS total_count
    FROM app.expense_cache ex
    JOIN app.currencies cur ON cur.id = ex.currency_id
    CROSS JOIN to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE ex.school_id = ${schoolId}::uuid AND ex.search_tsv @@ q.query
    ORDER BY rank DESC, ex.expense_date DESC, ex.id
    LIMIT ${limit} OFFSET ${offset}
  `;

interface RawNotificationRow {
  id: string;
  title: string;
  notification_type: string;
  read_at: Date | null;
  created_at: Date;
  rank: number;
}

/**
 * The caller's own inbox. notifications_owner_select (RLS) already limits every row to
 * `user_id = app.current_user_id()`; the explicit predicate repeats it so the query also reads as
 * what it is. Title only -- a body can name someone the title does not.
 */
const notificationQuery: SectionQuery<RawNotificationRow> = (
  { tx, schoolId, userId, terms },
  _mode,
  limit,
  offset,
) =>
  tx<(RawNotificationRow & Counted)[]>`
    SELECT n.id, n.title, n.notification_type::text, n.read_at, n.created_at,
           ts_rank(n.search_tsv, q.query) AS rank, count(*) OVER ()::int AS total_count
    FROM app.notifications n,
         to_tsquery('simple', app.search_normalize(${terms.tsquery})) AS q(query)
    WHERE n.school_id = ${schoolId}::uuid AND n.user_id = ${userId}::uuid
      AND n.search_tsv @@ q.query
    ORDER BY rank DESC, n.created_at DESC, n.id
    LIMIT ${limit} OFFSET ${offset}
  `;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function money(minor: string, minorUnit: number): { text: string; minor: number } {
  const value = BigInt(minor);
  return { text: formatMinorUnits(value, minorUnit), minor: Number(value) };
}

const rank = (row: { rank: number }) => Number(row.rank);

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface GlobalSearchOptions {
  schoolId: string;
  userId: string;
  query: string;
  types: readonly SearchType[];
  limit: number;
  offset: number;
  access: GlobalSearchAccess;
}

export interface GlobalSearchOutcome {
  results: GlobalSearchResult;
  totals: GlobalSearchTotals;
  /** Types that actually ran: requested AND permitted. */
  ran: SearchType[];
}

function emptyResult(): GlobalSearchResult {
  return {
    students: [],
    users: [],
    invoices: [],
    materials: [],
    classes: [],
    sections: [],
    subjects: [],
    grade_levels: [],
    academic_years: [],
    terms: [],
    rooms: [],
    families: [],
    announcements: [],
    events: [],
    incidents: [],
    evaluations: [],
    fee_structures: [],
    scholarships: [],
    expenses: [],
    notifications: [],
  };
}

function zeroTotals(): GlobalSearchTotals {
  return Object.fromEntries(SEARCH_TYPES.map((type) => [type, 0])) as GlobalSearchTotals;
}

/**
 * Runs the sections that are both requested and permitted, concurrently. A type that is not
 * requested, not permitted, or whose query has no letters or digits comes back as an empty array
 * and a zero total -- the response shape never depends on the caller's role, only its contents do.
 */
export async function globalSearch(
  tx: TransactionSql,
  options: GlobalSearchOptions,
): Promise<GlobalSearchOutcome> {
  const results = emptyResult();
  const totals = zeroTotals();
  const ran = SEARCH_TYPES.filter(
    (type) => options.types.includes(type) && options.access.sections[type],
  );
  const terms = buildSearchTerms(options.query);
  if (terms === null || ran.length === 0) return { results, totals, ran };

  // Transaction-local: the trigram floor for `<%` (also read by app.search_scoped_fuzzy_ids), and
  // no NOTICE for an English-stopword-only query against materials.
  await tx`
    SELECT set_config('pg_trgm.word_similarity_threshold', ${String(SEARCH_TRIGRAM_FLOOR)}, true),
           set_config('client_min_messages', 'warning', true)
  `;

  const context: SectionContext = {
    tx,
    schoolId: options.schoolId,
    userId: options.userId,
    terms,
    access: options.access,
  };
  const { limit, offset } = options;
  const run = <R extends Row>(query: SectionQuery<R>, fuzzy = false) =>
    runSection(context, query, limit, offset, fuzzy);

  const tasks: Record<SearchType, () => Promise<void>> = {
    students: async () => {
      const page = await run(studentQuery, true);
      totals.students = page.total;
      results.students = page.rows.map((row) => ({
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        preferred_name: row.preferred_name,
        admission_number: row.admission_number,
        status: row.status as StudentStatus,
        rank: rank(row),
      }));
    },
    users: async () => {
      const page = await run(userQuery, true);
      totals.users = page.total;
      results.users = page.rows.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        email: row.email,
        status: row.status as UserStatus,
        rank: rank(row),
      }));
    },
    invoices: async () => {
      const page = await run(invoiceQuery);
      totals.invoices = page.total;
      results.invoices = page.rows.map((row) => {
        const amount = money(row.total_amount_minor, row.currency_minor_unit);
        return {
          id: row.id,
          erpnext_docname: row.erpnext_docname,
          erpnext_status: row.erpnext_status,
          total_amount: amount.text,
          total_amount_minor: amount.minor,
          currency: row.currency_code,
          student_id: row.student_id,
          student_name: personName(
            row.student_preferred_name,
            row.student_first_name,
            row.student_last_name,
          ),
          rank: rank(row),
        };
      });
    },
    materials: async () => {
      const page = await run(materialQuery);
      totals.materials = page.total;
      results.materials = page.rows.map((row) => ({
        id: row.id,
        class_id: row.class_id,
        title: row.title,
        description: row.description,
        ingest_status: row.ingest_status as MaterialIngestStatus,
        rank: rank(row),
      }));
    },
    classes: async () => {
      const page = await run(classQuery, true);
      totals.classes = page.total;
      results.classes = page.rows.map((row) => ({
        id: row.id,
        code: row.code,
        course_id: row.course_id,
        course_name: row.course_name,
        status: row.status as ClassStatus,
        academic_year_id: row.academic_year_id,
        term_id: row.term_id,
        section_id: row.section_id,
        rank: rank(row),
      }));
    },
    sections: async () => {
      const page = await run(sectionQuery);
      totals.sections = page.total;
      results.sections = page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        grade_level_id: row.grade_level_id,
        grade_level_name: row.grade_level_name,
        academic_year_id: row.academic_year_id,
        archived: row.archived,
        rank: rank(row),
      }));
    },
    subjects: async () => {
      const page = await run(subjectQuery, true);
      totals.subjects = page.total;
      results.subjects = page.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status as CatalogStatus,
        rank: rank(row),
      }));
    },
    grade_levels: async () => {
      const page = await run(gradeLevelQuery);
      totals.grade_levels = page.total;
      results.grade_levels = page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        archived: row.archived,
        rank: rank(row),
      }));
    },
    academic_years: async () => {
      const page = await run(academicYearQuery);
      totals.academic_years = page.total;
      results.academic_years = page.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status as AcademicYearStatus,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
        rank: rank(row),
      }));
    },
    terms: async () => {
      const page = await run(termQuery);
      totals.terms = page.total;
      results.terms = page.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        academic_year_id: row.academic_year_id,
        academic_year_name: row.academic_year_name,
        status: row.status as AcademicYearStatus,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
        rank: rank(row),
      }));
    },
    rooms: async () => {
      const page = await run(roomQuery);
      totals.rooms = page.total;
      results.rooms = page.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        building: row.building,
        room_type: row.room_type as RoomType,
        is_active: row.is_active,
        rank: rank(row),
      }));
    },
    families: async () => {
      const page = await run(familyQuery, true);
      totals.families = page.total;
      results.families = page.rows.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        primary_parent_user_id: row.primary_parent_user_id,
        primary_parent_name: row.primary_parent_name,
        rank: rank(row),
      }));
    },
    announcements: async () => {
      const page = await run(announcementQuery);
      totals.announcements = page.total;
      results.announcements = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status as AnnouncementSearchHit["status"],
        audience_type: row.audience_type as AnnouncementSearchHit["audience_type"],
        scheduled_at: iso(row.scheduled_at),
        published_at: isoOrNull(row.published_at),
        rank: rank(row),
      }));
    },
    events: async () => {
      const page = await run(eventQuery);
      totals.events = page.total;
      results.events = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind as EventSearchHit["kind"],
        starts_on: row.starts_on,
        ends_on: row.ends_on,
        rank: rank(row),
      }));
    },
    incidents: async () => {
      const page = await run(incidentQuery);
      totals.incidents = page.total;
      results.incidents = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        incident_type: row.incident_type as DisciplineIncidentType,
        severity: row.severity as DisciplineSeverity,
        status: row.status as DisciplineIncidentStatus,
        incident_at: iso(row.incident_at),
        student_id: row.student_id,
        student_name: personName(
          row.student_preferred_name,
          row.student_first_name,
          row.student_last_name,
        ),
        class_id: row.class_id,
        rank: rank(row),
      }));
    },
    evaluations: async () => {
      const page = await run(evaluationQuery);
      totals.evaluations = page.total;
      results.evaluations = page.rows.map((row) => ({
        id: row.id,
        teacher_id: row.teacher_id,
        teacher_user_id: row.teacher_user_id,
        teacher_name: row.teacher_name,
        evaluation_type: row.evaluation_type,
        status: row.status,
        evaluated_at: iso(row.evaluated_at),
        class_id: row.class_id,
        rank: rank(row),
      }));
    },
    fee_structures: async () => {
      const page = await run(feeStructureQuery);
      totals.fee_structures = page.total;
      results.fee_structures = page.rows.map((row) => {
        const amount = money(row.total_amount_minor, row.currency_minor_unit);
        return {
          id: row.id,
          title: row.title,
          erpnext_name: row.erpnext_docname,
          erpnext_status: row.erpnext_status,
          is_active: row.is_active,
          total_amount: amount.text,
          total_amount_minor: amount.minor,
          currency: row.currency_code,
          academic_year_id: row.academic_year_id,
          academic_year_name: row.academic_year_name,
          rank: rank(row),
        };
      });
    },
    scholarships: async () => {
      const page = await run(scholarshipQuery);
      totals.scholarships = page.total;
      results.scholarships = page.rows.map((row) => {
        const amount =
          row.amount_minor !== null && row.currency_minor_unit !== null
            ? money(row.amount_minor, row.currency_minor_unit)
            : null;
        return {
          id: row.id,
          name: row.name,
          discount_type: row.discount_type as ScholarshipSearchHit["discount_type"],
          percentage: row.percentage,
          amount: amount?.text ?? null,
          amount_minor: amount?.minor ?? null,
          currency: row.currency_code,
          fee_category: row.fee_category,
          is_active: row.is_active,
          rank: rank(row),
        };
      });
    },
    expenses: async () => {
      const page = await run(expenseQuery);
      totals.expenses = page.total;
      results.expenses = page.rows.map((row) => {
        const amount = money(row.amount_minor, row.currency_minor_unit);
        return {
          id: row.id,
          vendor: row.vendor,
          category: row.category,
          document_type: row.document_type,
          erpnext_docname: row.erpnext_docname,
          erpnext_status: row.erpnext_status,
          amount: amount.text,
          amount_minor: amount.minor,
          currency: row.currency_code,
          expense_date: row.expense_date,
          rank: rank(row),
        };
      });
    },
    notifications: async () => {
      const page = await run(notificationQuery);
      totals.notifications = page.total;
      results.notifications = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        notification_type: row.notification_type,
        read_at: isoOrNull(row.read_at),
        created_at: iso(row.created_at),
        rank: rank(row),
      }));
    },
  };

  await Promise.all(ran.map((type) => tasks[type]()));
  return { results, totals, ran };
}
