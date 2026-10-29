/**
 * The missing-information list: current students and parents whose required fields or documents
 * are missing, and documents that have expired or expire within 30 days. Field labels only, never
 * a value. Each audience sees only the fields it may read (visibilitiesFor); leadership sees all.
 *
 * Runs under whatever transaction the route opens: RLS narrows a teacher to their students, and
 * finance reads through the identity transaction, as Finance > Unlinked does.
 */

import { visibilitiesFor } from "@studafy/records";

import type { RecordMissingIssue } from "./schemas";
import type { RecordAudience, RecordSubjectKind } from "@studafy/records";
import type { PendingQuery, Row, TransactionSql } from "postgres";

export interface MissingListParams {
  search?: string;
  issue: RecordMissingIssue;
  limit: number;
  offset: number;
}

interface MissingField {
  field_id: string;
  label_en: string;
  label_ar: string;
  expires_on: string | null;
}

interface IssueRow {
  subject_id: string;
  missing: MissingField[];
  expired: MissingField[];
  expiring: MissingField[];
}

const EXPIRING_WITHIN_DAYS = 30;

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * One row per subject with at least one issue (or the requested issue), with the issues as JSON
 * arrays. `subjects` is a query yielding (subject_id, sort_name) for the people in scope.
 */
function issuesQuery(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  audience: RecordAudience,
  subjects: PendingQuery<Row[]>,
  issue: RecordMissingIssue,
) {
  const visibilities = visibilitiesFor(audience);
  const sensitivityFilter = audience === "staff" ? tx`` : tx`AND fv.sensitivity = 'standard'`;
  const issueFilter =
    issue === "missing"
      ? tx`cardinality(i.missing) > 0`
      : issue === "expired"
        ? tx`cardinality(i.expired) > 0`
        : issue === "expiring"
          ? tx`cardinality(i.expiring) > 0`
          : tx`(cardinality(i.missing) + cardinality(i.expired) + cardinality(i.expiring)) > 0`;
  const subjectColumn = kind === "student" ? tx`a.student_id` : tx`a.parent_user_id`;

  return tx`
    WITH form AS (
      SELECT fv.field_id, fv.field_type, fv.label_en, fv.label_ar, fv.required, fv.sort_order
      FROM app.record_templates AS t
      JOIN app.record_template_versions AS tv
        ON tv.template_id = t.id AND tv.school_id = t.school_id AND tv.version = t.published_version
      JOIN app.record_field_versions AS fv
        ON fv.template_version_id = tv.id AND fv.school_id = tv.school_id
      WHERE t.school_id = ${schoolId}::uuid AND t.subject_kind = ${kind}::app.record_subject_kind
        AND fv.visibility = ANY(${visibilities}::app.record_field_visibility[])
        ${sensitivityFilter}
    ),
    people AS (${subjects}),
    answers AS (
      SELECT ${subjectColumn} AS subject_id, a.field_id,
             (a.value IS NOT NULL OR a.value_ciphertext IS NOT NULL) AS has_value,
             d.status AS document_status, d.expires_on
      FROM app.record_answers AS a
      LEFT JOIN app.record_documents AS d ON d.answer_id = a.id AND d.school_id = a.school_id
      WHERE a.school_id = ${schoolId}::uuid AND a.subject_kind = ${kind}::app.record_subject_kind
        AND a.field_id IN (SELECT field_id FROM form)
    ),
    issues AS (
      SELECT p.subject_id, p.sort_name,
        coalesce(array_agg(
          jsonb_build_object('field_id', f.field_id, 'label_en', f.label_en,
                             'label_ar', f.label_ar, 'expires_on', NULL)
          ORDER BY f.sort_order
        ) FILTER (WHERE f.required AND (
          (f.field_type = 'document' AND coalesce(ans.document_status, 'missing') = 'missing')
          OR (f.field_type <> 'document' AND NOT coalesce(ans.has_value, false))
        )), '{}') AS missing,
        coalesce(array_agg(
          jsonb_build_object('field_id', f.field_id, 'label_en', f.label_en,
                             'label_ar', f.label_ar,
                             'expires_on', to_char(ans.expires_on, 'YYYY-MM-DD'))
          ORDER BY ans.expires_on
        ) FILTER (WHERE ans.document_status <> 'missing' AND ans.expires_on < CURRENT_DATE), '{}')
          AS expired,
        coalesce(array_agg(
          jsonb_build_object('field_id', f.field_id, 'label_en', f.label_en,
                             'label_ar', f.label_ar,
                             'expires_on', to_char(ans.expires_on, 'YYYY-MM-DD'))
          ORDER BY ans.expires_on
        ) FILTER (WHERE ans.document_status <> 'missing'
                    AND ans.expires_on >= CURRENT_DATE
                    AND ans.expires_on <= CURRENT_DATE + ${EXPIRING_WITHIN_DAYS}::int), '{}')
          AS expiring
      FROM people AS p
      CROSS JOIN form AS f
      LEFT JOIN answers AS ans ON ans.subject_id = p.subject_id AND ans.field_id = f.field_id
      GROUP BY p.subject_id, p.sort_name
    )
    SELECT i.subject_id, i.sort_name, to_jsonb(i.missing) AS missing,
           to_jsonb(i.expired) AS expired, to_jsonb(i.expiring) AS expiring
    FROM issues AS i
    WHERE ${issueFilter}
  `;
}

/** Students still at the school (not graduated, withdrawn or archived). */
function studentScope(tx: TransactionSql, schoolId: string, search?: string) {
  const term = search?.trim();
  const nameFilter = term
    ? tx`AND (s.first_name || ' ' || s.last_name ILIKE ${likePattern(term)}
          OR coalesce(s.preferred_name, '') || ' ' || s.last_name ILIKE ${likePattern(term)}
          OR s.admission_number ILIKE ${likePattern(term)})`
    : tx``;
  return tx`
    SELECT s.id AS subject_id, lower(s.last_name || ' ' || s.first_name) AS sort_name
    FROM app.students AS s
    WHERE s.school_id = ${schoolId}::uuid AND s.left_at IS NULL
      AND s.status NOT IN ('graduated', 'withdrawn', 'archived')
      ${nameFilter}
  `;
}

function parentScope(tx: TransactionSql, schoolId: string, search?: string) {
  const term = search?.trim();
  const nameFilter = term
    ? tx`AND (u.display_name ILIKE ${likePattern(term)} OR u.email ILIKE ${likePattern(term)})`
    : tx``;
  return tx`
    SELECT u.id AS subject_id, lower(coalesce(u.display_name, u.email, '')) AS sort_name
    FROM app.users AS u
    WHERE u.school_id = ${schoolId}::uuid AND u.status <> 'archived'
      AND EXISTS (
        SELECT 1 FROM app.user_roles AS role
        WHERE role.school_id = u.school_id AND role.user_id = u.id AND role.role = 'PARENT'
      )
      ${nameFilter}
  `;
}

async function page(
  tx: TransactionSql,
  query: PendingQuery<Row[]>,
  params: MissingListParams,
): Promise<{ rows: IssueRow[]; total: number }> {
  const [count] = await tx<{ total: number }[]>`SELECT count(*)::int AS total FROM (${query}) AS q`;
  const rows = await tx<IssueRow[]>`
    SELECT * FROM (${query}) AS q
    ORDER BY q.sort_name, q.subject_id
    LIMIT ${params.limit} OFFSET ${params.offset}
  `;
  return { rows, total: count?.total ?? 0 };
}

export async function listMissingStudents(
  tx: TransactionSql,
  schoolId: string,
  audience: RecordAudience,
  params: MissingListParams,
) {
  const query = issuesQuery(
    tx,
    schoolId,
    "student",
    audience,
    studentScope(tx, schoolId, params.search),
    params.issue,
  );
  const { rows, total } = await page(tx, query, params);
  const ids = rows.map((row) => row.subject_id);
  const identities = ids.length
    ? await tx<{ id: string; name: string; admission_number: string }[]>`
        SELECT id, coalesce(preferred_name, first_name) || ' ' || last_name AS name, admission_number
        FROM app.students WHERE school_id = ${schoolId}::uuid AND id = ANY(${ids}::uuid[])
      `
    : [];
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  return {
    students: rows.map((row) => ({
      student_id: row.subject_id,
      name: byId.get(row.subject_id)?.name ?? "",
      admission_number: byId.get(row.subject_id)?.admission_number ?? "",
      missing: row.missing,
      expired: row.expired,
      expiring: row.expiring,
    })),
    total,
    issue: params.issue,
  };
}

/** Parents' records are leadership's and finance's: other audiences get an empty list. */
export async function listMissingParents(
  tx: TransactionSql,
  schoolId: string,
  audience: RecordAudience,
  params: MissingListParams,
) {
  if (audience !== "staff" && audience !== "finance") {
    return { parents: [], total: 0, issue: params.issue };
  }
  const query = issuesQuery(
    tx,
    schoolId,
    "parent",
    audience,
    parentScope(tx, schoolId, params.search),
    params.issue,
  );
  const { rows, total } = await page(tx, query, params);
  const ids = rows.map((row) => row.subject_id);
  const identities = ids.length
    ? await tx<{ id: string; name: string; email: string | null }[]>`
        SELECT id, coalesce(display_name, email, '') AS name, email
        FROM app.users WHERE school_id = ${schoolId}::uuid AND id = ANY(${ids}::uuid[])
      `
    : [];
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  return {
    parents: rows.map((row) => ({
      user_id: row.subject_id,
      name: byId.get(row.subject_id)?.name ?? "",
      email: byId.get(row.subject_id)?.email ?? null,
      missing: row.missing,
      expired: row.expired,
      expiring: row.expiring,
    })),
    total,
    issue: params.issue,
  };
}

export async function missingSummary(
  tx: TransactionSql,
  schoolId: string,
  audience: RecordAudience,
) {
  const students = issuesQuery(
    tx,
    schoolId,
    "student",
    audience,
    studentScope(tx, schoolId),
    "all",
  );
  const includeParents = audience === "staff" || audience === "finance";
  const [studentCounts] = await tx<{ people: number; expired: number; expiring: number }[]>`
    SELECT count(*)::int AS people,
           coalesce(sum(jsonb_array_length(q.expired)), 0)::int AS expired,
           coalesce(sum(jsonb_array_length(q.expiring)), 0)::int AS expiring
    FROM (${students}) AS q
  `;
  let parentCounts = { people: 0, expired: 0, expiring: 0 };
  if (includeParents) {
    const parents = issuesQuery(tx, schoolId, "parent", audience, parentScope(tx, schoolId), "all");
    const [row] = await tx<{ people: number; expired: number; expiring: number }[]>`
      SELECT count(*)::int AS people,
             coalesce(sum(jsonb_array_length(q.expired)), 0)::int AS expired,
             coalesce(sum(jsonb_array_length(q.expiring)), 0)::int AS expiring
      FROM (${parents}) AS q
    `;
    parentCounts = row ?? parentCounts;
  }
  return {
    students: studentCounts?.people ?? 0,
    parents: parentCounts.people,
    expired_documents: (studentCounts?.expired ?? 0) + parentCounts.expired,
    expiring_documents: (studentCounts?.expiring ?? 0) + parentCounts.expiring,
  };
}
