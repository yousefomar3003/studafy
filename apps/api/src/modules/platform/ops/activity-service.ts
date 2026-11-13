/**
 * Super admin activity log: what Studafy's own staff did, across every school.
 *
 * ## Where the rows are
 *
 * A console action is audited twice (modules/platform/service.ts, licensing/context.ts): one row in
 * the affected school with a NULL actor, and one in the operator's HOME school with the operator as
 * actor. Platform roles exist only in schools flagged `is_platform_tenant` (000185), so the
 * accountable rows -- actor set, actor holding SUPER_ADMIN or SUPPORT_AGENT -- live in those few
 * schools. This reads them there, one school scope at a time (RLS is FORCEd onto studafy_admin
 * too), on idx_audit_logs_school_actor (school_id, actor_id, created_at DESC): no new index.
 *
 * ## Which school was affected
 *
 * The home row does not name the school it acted on, but both rows of one action share the
 * request's id and the same (target_table, target_id). For one page of home rows, every school is
 * asked -- one small statement each, pipelined, on idx_audit_logs_school_target -- for system rows
 * with those targets and request ids; a match names the affected school. No match means the action
 * was on a global table (plans, settings, announcements) or on the operator's own school.
 *
 * Filtering by school runs the other way: that school's own system rows in the date window give the
 * request ids, and the home rows are then filtered to them.
 */

import { PLATFORM_ROLES } from "@studafy/constants";

import { pipelinePerSchool, setTenantScope, withSystemTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db/client";
import type { TransactionSql } from "postgres";

const MAX_WINDOW_DAYS = 366;
/** System rows read from one school when filtering by it -- bounds the school filter's cost. */
const SCHOOL_FILTER_SCAN = 2000;

export interface ActivityFilters {
  from: Date;
  to: Date;
  actorId?: string;
  action?: string;
  targetTable?: string;
  schoolId?: string;
  limit: number;
  /** `<createdAtIso>|<id>` of the last row of the previous page. */
  cursor?: string;
}

export interface ActivityEntry {
  id: string;
  createdAt: string;
  actor: { userId: string; name: string | null; email: string; homeSchoolId: string };
  action: string;
  targetTable: string;
  targetId: string;
  affectedSchool: { id: string; name: string } | null;
  reason: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  requestId: string | null;
}

export interface PlatformOperator {
  userId: string;
  name: string | null;
  email: string;
  roles: string[];
  homeSchoolId: string;
  homeSchoolName: string;
}

interface HomeRow {
  id: string;
  created_at: Date;
  actor_id: string;
  display_name: string | null;
  email: string;
  action: string;
  target_table: string;
  target_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  request_id: string | null;
}

function parseCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at: date, id };
}

function reasonOf(values: Record<string, unknown> | null): string | null {
  const reason = values?.reason;
  return typeof reason === "string" && reason.trim() !== "" ? reason : null;
}

async function platformSchools(tx: TransactionSql) {
  return tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.schools WHERE is_platform_tenant ORDER BY name
  `;
}

/** Studafy staff accounts (SUPER_ADMIN / SUPPORT_AGENT), for the console's "who" filter. */
export async function listPlatformOperators(database: Database): Promise<PlatformOperator[]> {
  return withSystemTx(database, async (tx) => {
    const homes = await platformSchools(tx);
    const results = await pipelinePerSchool(tx, homes, () => [
      tx<{ id: string; display_name: string | null; email: string; roles: string[] }[]>`
        SELECT u.id, u.display_name, u.email,
               array_agg(r.role::text ORDER BY r.role) AS roles
        FROM app.users u
        JOIN app.user_roles r ON r.user_id = u.id
        WHERE r.role::text = ANY(${[...PLATFORM_ROLES]}::text[])
        GROUP BY u.id
        ORDER BY lower(coalesce(u.display_name, u.email))
      `,
    ]);
    return homes.flatMap((home, index) =>
      results[index]![0].map((user) => ({
        userId: user.id,
        name: user.display_name,
        email: user.email,
        roles: user.roles,
        homeSchoolId: home.id,
        homeSchoolName: home.name,
      })),
    );
  });
}

export async function listPlatformActivity(
  database: Database,
  filters: ActivityFilters,
): Promise<{ entries: ActivityEntry[]; nextCursor: string | null }> {
  const to = filters.to;
  const earliest = new Date(to.getTime() - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const from = filters.from.getTime() < earliest.getTime() ? earliest : filters.from;
  const cursor = parseCursor(filters.cursor);

  return withSystemTx(database, async (tx) => {
    const homes = await platformSchools(tx);
    if (homes.length === 0) return { entries: [], nextCursor: null };

    // School filter: request ids of that school's system-attributed rows in the window.
    let requestIds: string[] | null = null;
    if (filters.schoolId) {
      await setTenantScope(tx, filters.schoolId);
      const rows = await tx<{ request_id: string }[]>`
        SELECT DISTINCT request_id::text AS request_id FROM (
          SELECT request_id FROM app.audit_logs
          WHERE created_at >= ${from} AND created_at < ${to}
            AND actor_id IS NULL AND request_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ${SCHOOL_FILTER_SCAN}
        ) AS recent
      `;
      await tx`SELECT set_config('app.school_id', '', true)`;
      requestIds = rows.map((row) => row.request_id);
    }

    const perHome = await pipelinePerSchool(tx, homes, () => [
      tx<HomeRow[]>`
        SELECT a.id, a.created_at, a.actor_id, u.display_name, u.email, a.action::text AS action,
               a.target_table, a.target_id, a.old_values, a.new_values,
               a.request_id::text AS request_id
        FROM app.audit_logs a
        JOIN app.users u ON u.id = a.actor_id
        WHERE a.actor_id IN (
            SELECT r.user_id FROM app.user_roles r
            WHERE r.role::text = ANY(${[...PLATFORM_ROLES]}::text[])
              ${filters.actorId ? tx`AND r.user_id = ${filters.actorId}::uuid` : tx``}
          )
          AND a.created_at >= ${from} AND a.created_at < ${to}
          ${filters.action ? tx`AND a.action::text = ${filters.action}` : tx``}
          ${filters.targetTable ? tx`AND a.target_table = ${filters.targetTable}` : tx``}
          ${requestIds ? tx`AND a.request_id::text = ANY(${requestIds}::text[])` : tx``}
          ${cursor ? tx`AND (a.created_at, a.id) < (${cursor.at}, ${cursor.id}::uuid)` : tx``}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${filters.limit + 1}
      `,
    ]);

    const merged = homes
      .flatMap((home, index) => perHome[index]![0].map((row) => ({ home, row })))
      .sort((a, b) => {
        const diff = b.row.created_at.getTime() - a.row.created_at.getTime();
        return diff !== 0 ? diff : b.row.id.localeCompare(a.row.id);
      });
    const page = merged.slice(0, filters.limit);
    const hasMore = merged.length > filters.limit;

    const affected = await resolveAffectedSchools(
      tx,
      page.map((entry) => entry.row),
      filters.schoolId ?? null,
    );

    const entries: ActivityEntry[] = page.map(({ home, row }) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      actor: {
        userId: row.actor_id,
        name: row.display_name,
        email: row.email,
        homeSchoolId: home.id,
      },
      action: row.action,
      targetTable: row.target_table,
      targetId: row.target_id,
      affectedSchool: affected.get(row.id) ?? null,
      reason: reasonOf(row.new_values) ?? reasonOf(row.old_values),
      oldValues: row.old_values,
      newValues: row.new_values,
      requestId: row.request_id,
    }));

    const last = page.at(-1)?.row;
    return {
      entries,
      nextCursor: hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null,
    };
  });
}

/** Home row id -> the school the action changed, found by its system-attributed twin. */
async function resolveAffectedSchools(
  tx: TransactionSql,
  rows: readonly HomeRow[],
  filteredSchoolId: string | null,
): Promise<Map<string, { id: string; name: string }>> {
  const result = new Map<string, { id: string; name: string }>();
  const withRequest = rows.filter((row) => row.request_id !== null);
  if (withRequest.length === 0) return result;

  const schools = filteredSchoolId
    ? await tx<{ id: string; name: string }[]>`
        SELECT id, name FROM app.schools WHERE id = ${filteredSchoolId}::uuid
      `
    : await tx<{ id: string; name: string }[]>`SELECT id, name FROM app.schools ORDER BY id`;

  const times = withRequest.map((row) => row.created_at.getTime());
  // Both rows are written in one transaction, so they share created_at's statement clock to within
  // the transaction; a minute of slack either side is generous and keeps partition pruning.
  const low = new Date(Math.min(...times) - 60_000);
  const high = new Date(Math.max(...times) + 60_000);
  const tables = withRequest.map((row) => row.target_table);
  const targets = withRequest.map((row) => row.target_id);
  const requests = withRequest.map((row) => row.request_id!);

  const matches = await pipelinePerSchool(tx, schools, () => [
    tx<{ target_table: string; target_id: string; request_id: string }[]>`
      SELECT a.target_table, a.target_id, a.request_id::text AS request_id
      FROM unnest(${tables}::text[], ${targets}::uuid[], ${requests}::uuid[]) AS t(tt, tid, rid)
      JOIN app.audit_logs a
        ON a.target_table = t.tt AND a.target_id = t.tid AND a.request_id = t.rid
      WHERE a.actor_id IS NULL AND a.created_at >= ${low} AND a.created_at <= ${high}
    `,
  ]);

  const byKey = new Map<string, { id: string; name: string }>();
  schools.forEach((school, index) => {
    for (const match of matches[index]![0]) {
      byKey.set(`${match.target_table}|${match.target_id}|${match.request_id}`, school);
    }
  });
  for (const row of withRequest) {
    const school = byKey.get(`${row.target_table}|${row.target_id}|${row.request_id}`);
    if (school) result.set(row.id, school);
  }
  return result;
}
