/**
 * Studafy platform console service: the cross-school operations only Studafy staff perform.
 *
 * ## How a cross-tenant read works here
 *
 * There is no BYPASSRLS role and every tenant table FORCEs its `tenant_isolation` policy onto
 * `studafy_admin` too (ADR-0015), with `current_setting('app.school_id')` read fail-closed. So
 * nothing in this file ever queries a tenant table across schools in one statement. Global tables
 * (`schools`, `plans`, `plan_prices`, `platform_settings`, `countries`, `currencies`) are read
 * directly; per-school figures are read by arming each school's scope in turn with
 * `setTenantScope` inside one `withSystemTx` -- the GUC is transaction-local and re-settable, so a
 * single connection walks the schools one at a time without ever widening any policy. That costs
 * one small query per school, which is the price of keeping isolation provable; list endpoints
 * page the schools first so a page costs at most `limit` of them.
 *
 * ## Audit
 *
 * `app.audit_logs.actor_id` has a composite FK to `(users.id, school_id)`, and a platform operator
 * is a user of their *home* school, not of the school they act on. So a change to a school writes
 * two rows: one in the affected school with a NULL actor (how that school sees "Studafy did this",
 * the same convention webhook-driven rows use), and one in the operator's home school with the
 * operator as actor (accountability for which staffer did it). Changes to global tables have no
 * school of their own and are audited in the operator's home school only.
 */

import { FEATURE_FLAGS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { cacheKey } from "../../cache";
import { setTenantScope, withSystemTx } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { MemberStatus, SchoolStatus } from "./schemas";
import type { Database } from "../../db/client";
import type { AuditEntry } from "../../middleware/auditEmitter";
import type { RedisClient } from "../../redis";
import type { InquiryStatus } from "../inquiries/schemas";
import type { FeatureFlagDefinition, FlagName, Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * The school lifecycle from docs/database/global-tables.md, which says transitions are
 * application-enforced. This table is that enforcement. `archived` is terminal.
 */
export const SCHOOL_TRANSITIONS: ReadonlyMap<SchoolStatus, readonly SchoolStatus[]> = new Map([
  // Self-registered, email not yet verified (tenancy/verification moves it to active).
  ["registered", ["active", "archived"]],
  ["pending", ["active", "archived"]],
  ["active", ["suspended", "archived"]],
  ["suspended", ["active", "archived"]],
  ["archived", []],
]);

export function allowedTransitions(from: SchoolStatus): readonly SchoolStatus[] {
  return SCHOOL_TRANSITIONS.get(from) ?? [];
}

export function canTransition(from: SchoolStatus, to: SchoolStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/**
 * What a status change means for students' AI billing: suspending or archiving stops it, and only
 * a return from `suspended` to `active` restarts it. `null` means AI billing is untouched.
 */
export function aiBillingEffect(from: SchoolStatus, to: SchoolStatus): "pause" | "resume" | null {
  if (to === "suspended" || to === "archived") return from === "archived" ? null : "pause";
  if (from === "suspended" && to === "active") return "resume";
  return null;
}

/**
 * The AI billing effect to replay when an operator re-sends a school's current status. Both
 * directions are idempotent at the provider and in the state machine (only `paused` subscriptions
 * resume, only live ones pause), so replaying against a school that never needed it is a no-op.
 */
export function retryEffect(status: SchoolStatus): "pause" | "resume" | null {
  if (status === "suspended" || status === "archived") return "pause";
  if (status === "active") return "resume";
  return null;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface SchoolRow {
  id: string;
  slug: string;
  name: string;
  email: string;
  status: SchoolStatus;
  school_number: number;
  country_code: string;
  currency_code: string;
  is_review_tenant: boolean;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SchoolStatsRow {
  active_users: number;
  students: number;
  plan_code: string | null;
  plan_name: string | null;
  subscription_status: string | null;
  student_cap: number | null;
  trial_expires_at: Date | null;
  current_period_end: Date | null;
  active_ai_subscriptions: number;
}

export interface Actor {
  userId: string;
  schoolId: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SCHOOL_COLUMNS = (tx: TransactionSql) => tx`
  s.id, s.slug, s.name, s.email, s.status::text AS status, s.school_number,
  c.alpha2_code AS country_code, cur.code AS currency_code,
  s.is_review_tenant, s.email_verified_at, s.created_at, s.updated_at
`;

async function loadSchool(tx: TransactionSql, schoolId: string, lock = false) {
  const rows = await tx<SchoolRow[]>`
    SELECT ${SCHOOL_COLUMNS(tx)}
    FROM app.schools s
    JOIN app.countries c ON c.id = s.country_id
    JOIN app.currencies cur ON cur.id = s.default_currency_id
    WHERE s.id = ${schoolId}
    ${lock ? tx`FOR UPDATE OF s` : tx``}
  `;
  const row = rows[0];
  if (!row) throw new HTTPException(404, { message: "School not found" });
  return row;
}

/** Arms `schoolId`'s scope and reads its per-school figures. Leaves the scope armed. */
async function loadSchoolStats(tx: TransactionSql, schoolId: string): Promise<SchoolStatsRow> {
  await setTenantScope(tx, schoolId);
  const rows = await tx<SchoolStatsRow[]>`
    SELECT
      (SELECT count(*)::int FROM app.users WHERE status = 'active') AS active_users,
      (SELECT count(DISTINCT user_id)::int FROM app.user_roles WHERE role = 'STUDENT') AS students,
      p.code AS plan_code,
      p.display_name AS plan_name,
      sub.status::text AS subscription_status,
      sub.student_cap,
      sub.trial_expires_at,
      sub.current_period_end,
      (SELECT count(*)::int FROM app.ai_subscriptions WHERE status = 'active') AS active_ai_subscriptions
    FROM (SELECT 1) AS one
    LEFT JOIN app.subscriptions sub ON true
    LEFT JOIN app.plans p ON p.id = sub.plan_id
  `;
  return rows[0]!;
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

function toSummary(school: SchoolRow, stats: SchoolStatsRow) {
  return {
    id: school.id,
    slug: school.slug,
    name: school.name,
    email: school.email,
    status: school.status,
    schoolNumber: school.school_number,
    countryCode: school.country_code,
    currencyCode: school.currency_code,
    isReviewTenant: school.is_review_tenant,
    createdAt: iso(school.created_at),
    activeUsers: stats.active_users,
    students: stats.students,
    subscription:
      stats.plan_code && stats.subscription_status && stats.current_period_end
        ? {
            planCode: stats.plan_code,
            planName: stats.plan_name ?? stats.plan_code,
            status: stats.subscription_status,
            studentCap: stats.student_cap ?? 0,
            trialExpiresAt: isoOrNull(stats.trial_expires_at),
            currentPeriodEnd: iso(stats.current_period_end),
          }
        : null,
  };
}

/**
 * Writes one audit row under `schoolId`, attributed to `actorUserId` (or to the system when null).
 * Re-arms both GUCs the emitter reads, so callers can interleave rows for different schools.
 */
async function auditIn(
  tx: TransactionSql,
  schoolId: string,
  actorUserId: string | null,
  entry: AuditEntry,
  requestId?: string,
): Promise<void> {
  await setTenantScope(tx, schoolId, requestId);
  await tx`SELECT set_config('app.user_id', ${actorUserId ?? ""}, true)`;
  await emitAuditLog(tx, entry);
}

/** The affected school's system-attributed row, plus the operator's own attributed row. */
async function auditSchoolChange(
  tx: TransactionSql,
  schoolId: string,
  actor: Actor,
  entry: AuditEntry,
): Promise<void> {
  if (actor.schoolId === schoolId) {
    await auditIn(tx, schoolId, actor.userId, entry, actor.requestId);
    return;
  }
  await auditIn(tx, schoolId, null, entry, actor.requestId);
  await auditIn(tx, actor.schoolId, actor.userId, entry, actor.requestId);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function getPlatformOverview(database: Database) {
  return withSystemTx(database, async (tx) => {
    const schools = await tx<
      { id: string; status: SchoolStatus; created_at: Date }[]
    >`SELECT id, status::text AS status, created_at FROM app.schools`;

    const schoolsByStatus: Record<SchoolStatus, number> = {
      registered: 0,
      pending: 0,
      active: 0,
      suspended: 0,
      archived: 0,
    };
    const subscriptionsByStatus: Record<string, number> = {};
    const subscriptionsByPlan: Record<string, number> = {};
    const now = Date.now();
    const DAY = 86_400_000;
    let newSchoolsLast30Days = 0;
    let totalActiveUsers = 0;
    let totalStudents = 0;
    let trialsEndingIn7Days = 0;
    let activeAiSubscriptions = 0;

    for (const school of schools) {
      schoolsByStatus[school.status] += 1;
      if (now - school.created_at.getTime() <= 30 * DAY) newSchoolsLast30Days += 1;

      const stats = await loadSchoolStats(tx, school.id);
      totalActiveUsers += stats.active_users;
      totalStudents += stats.students;
      activeAiSubscriptions += stats.active_ai_subscriptions;
      if (stats.subscription_status) {
        subscriptionsByStatus[stats.subscription_status] =
          (subscriptionsByStatus[stats.subscription_status] ?? 0) + 1;
      }
      if (stats.plan_code) {
        subscriptionsByPlan[stats.plan_code] = (subscriptionsByPlan[stats.plan_code] ?? 0) + 1;
      }
      const trialEnd = stats.trial_expires_at?.getTime();
      if (
        stats.subscription_status === "trialing" &&
        trialEnd !== undefined &&
        trialEnd >= now &&
        trialEnd - now <= 7 * DAY
      ) {
        trialsEndingIn7Days += 1;
      }
    }

    return {
      schoolsByStatus,
      totalSchools: schools.length,
      newSchoolsLast30Days,
      totalActiveUsers,
      totalStudents,
      subscriptionsByStatus,
      subscriptionsByPlan,
      trialsEndingIn7Days,
      activeAiSubscriptions,
      generatedAt: new Date(now).toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

/** Subscription statuses that are still billed, so count toward recurring revenue. */
const BILLED_STATUSES = new Set(["active", "past_due", "grace_period"]);
const TRIAL_ENDING_WINDOW_DAYS = 14;
const RENEWAL_WINDOW_DAYS = 30;
const RECENT_FAILED_RENEWALS_LIMIT = 10;

export type FinanceAttentionReason =
  "past_due" | "grace_period" | "paused" | "cancel_scheduled" | "trial_ending";

interface FinanceSchoolRow {
  id: string;
  name: string;
  currency_code: string;
  minor_unit: number;
  default_currency_id: string;
}

interface FinanceSubscriptionRow {
  status: string;
  plan_id: string;
  plan_name: string;
  cancel_at_period_end: boolean;
  grace_period_ends_at: Date | null;
  trial_expires_at: Date | null;
  current_period_end: Date;
}

interface RenewalAggregateRow {
  currency_code: string;
  minor_unit: number;
  status: string;
  attempts: number;
  amount_minor: string;
}

interface FailedRenewalRow {
  id: string;
  subscription_type: "school" | "ai";
  attempted_at: Date;
  amount_minor: string;
  currency_code: string;
  minor_unit: number;
  failure_reason: string | null;
}

/**
 * Studafy's own revenue picture, across every school: estimated recurring revenue per currency,
 * the last 30 days of renewal charges, schools whose billing needs a human, and the latest failed
 * renewals. Review tenants are excluded -- they are never billed.
 *
 * MRR is an *estimate* at list price: `app.subscriptions` records the plan but not the billing
 * interval or any discount, so each billed school contributes its plan's monthly price in its
 * currency (or the yearly price / 12 when the plan has no monthly price there).
 */
export async function getPlatformFinance(database: Database) {
  return withSystemTx(database, async (tx) => {
    const schools = await tx<FinanceSchoolRow[]>`
      SELECT s.id, s.name, cur.code AS currency_code, cur.minor_unit::int AS minor_unit,
             s.default_currency_id
      FROM app.schools s
      JOIN app.currencies cur ON cur.id = s.default_currency_id
      WHERE NOT s.is_review_tenant
      ORDER BY s.name, s.id
    `;

    // Global table, read once: plan -> currency -> monthly-equivalent price in minor units.
    const priceRows = await tx<
      { plan_id: string; currency_id: string; billing_interval: string; amount_minor: string }[]
    >`SELECT plan_id, currency_id, billing_interval::text, amount_minor::text FROM app.plan_prices`;
    const monthlyPrice = new Map<string, number>();
    for (const row of priceRows) {
      const key = `${row.plan_id}:${row.currency_id}`;
      const amount = Number(row.amount_minor);
      if (row.billing_interval === "monthly") monthlyPrice.set(key, amount);
      else if (!monthlyPrice.has(key)) monthlyPrice.set(key, Math.round(amount / 12));
    }

    const now = Date.now();
    const DAY = 86_400_000;
    const renewalSince = new Date(now - RENEWAL_WINDOW_DAYS * DAY);

    const revenue = new Map<
      string,
      { currencyCode: string; minorUnit: number; estimatedMrrMinor: number; billedSchools: number }
    >();
    const renewals = new Map<
      string,
      {
        currencyCode: string;
        minorUnit: number;
        collectedMinor: number;
        succeeded: number;
        failed: number;
      }
    >();
    const attention: {
      schoolId: string;
      schoolName: string;
      reason: FinanceAttentionReason;
      subscriptionStatus: string;
      planName: string;
      dueAt: string | null;
    }[] = [];
    const failedRenewals: {
      id: string;
      schoolId: string;
      schoolName: string;
      subscriptionType: "school" | "ai";
      attemptedAt: string;
      amountMinor: number;
      currencyCode: string;
      minorUnit: number;
      failureReason: string | null;
    }[] = [];

    for (const school of schools) {
      await setTenantScope(tx, school.id);

      const [sub] = await tx<FinanceSubscriptionRow[]>`
        SELECT sub.status::text AS status, sub.plan_id, p.display_name AS plan_name,
               sub.cancel_at_period_end, sub.grace_period_ends_at, sub.trial_expires_at,
               sub.current_period_end
        FROM app.subscriptions sub
        JOIN app.plans p ON p.id = sub.plan_id
      `;

      if (sub) {
        if (BILLED_STATUSES.has(sub.status)) {
          const bucket = revenue.get(school.currency_code) ?? {
            currencyCode: school.currency_code,
            minorUnit: school.minor_unit,
            estimatedMrrMinor: 0,
            billedSchools: 0,
          };
          bucket.estimatedMrrMinor +=
            monthlyPrice.get(`${sub.plan_id}:${school.default_currency_id}`) ?? 0;
          bucket.billedSchools += 1;
          revenue.set(school.currency_code, bucket);
        }

        const flag = (reason: FinanceAttentionReason, dueAt: Date | null) =>
          attention.push({
            schoolId: school.id,
            schoolName: school.name,
            reason,
            subscriptionStatus: sub.status,
            planName: sub.plan_name,
            dueAt: isoOrNull(dueAt),
          });
        const trialEnd = sub.trial_expires_at?.getTime();
        if (sub.status === "past_due") flag("past_due", sub.current_period_end);
        else if (sub.status === "grace_period") flag("grace_period", sub.grace_period_ends_at);
        else if (sub.status === "paused") flag("paused", null);
        else if (
          sub.status === "trialing" &&
          trialEnd !== undefined &&
          trialEnd >= now &&
          trialEnd - now <= TRIAL_ENDING_WINDOW_DAYS * DAY
        ) {
          flag("trial_ending", sub.trial_expires_at);
        }
        if (sub.cancel_at_period_end && (sub.status === "active" || sub.status === "trialing")) {
          flag("cancel_scheduled", sub.current_period_end);
        }
      }

      const aggregates = await tx<RenewalAggregateRow[]>`
        SELECT r.currency_code, COALESCE(cur.minor_unit, 2)::int AS minor_unit, r.status::text,
               count(*)::int AS attempts, COALESCE(sum(r.amount_minor), 0)::text AS amount_minor
        FROM app.tap_renewal_attempts r
        LEFT JOIN app.currencies cur ON cur.code = r.currency_code
        WHERE r.attempted_at >= ${renewalSince}
        GROUP BY r.currency_code, cur.minor_unit, r.status
      `;
      for (const row of aggregates) {
        const bucket = renewals.get(row.currency_code) ?? {
          currencyCode: row.currency_code,
          minorUnit: row.minor_unit,
          collectedMinor: 0,
          succeeded: 0,
          failed: 0,
        };
        if (row.status === "succeeded") {
          bucket.succeeded += row.attempts;
          bucket.collectedMinor += Number(row.amount_minor);
        } else if (row.status === "failed") {
          bucket.failed += row.attempts;
        }
        renewals.set(row.currency_code, bucket);
      }

      const failed = await tx<FailedRenewalRow[]>`
        SELECT r.id, r.subscription_type::text AS subscription_type, r.attempted_at,
               r.amount_minor::text, r.currency_code, COALESCE(cur.minor_unit, 2)::int AS minor_unit,
               r.failure_reason
        FROM app.tap_renewal_attempts r
        LEFT JOIN app.currencies cur ON cur.code = r.currency_code
        WHERE r.status = 'failed'
        ORDER BY r.attempted_at DESC
        LIMIT ${RECENT_FAILED_RENEWALS_LIMIT}
      `;
      for (const row of failed) {
        failedRenewals.push({
          id: row.id,
          schoolId: school.id,
          schoolName: school.name,
          subscriptionType: row.subscription_type,
          attemptedAt: iso(row.attempted_at),
          amountMinor: Number(row.amount_minor),
          currencyCode: row.currency_code,
          minorUnit: row.minor_unit,
          failureReason: row.failure_reason,
        });
      }
    }

    const byCurrency = <T extends { currencyCode: string }>(values: Iterable<T>) =>
      [...values].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));

    return {
      revenueByCurrency: byCurrency(revenue.values()),
      renewalsLast30Days: byCurrency(renewals.values()),
      attention,
      recentFailedRenewals: failedRenewals
        .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))
        .slice(0, RECENT_FAILED_RENEWALS_LIMIT),
      generatedAt: new Date(now).toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Schools
// ---------------------------------------------------------------------------

export interface SchoolListFilters {
  search?: string;
  status?: SchoolStatus;
  limit: number;
  offset: number;
}

export async function listSchools(database: Database, filters: SchoolListFilters) {
  return withSystemTx(database, async (tx) => {
    const pattern = filters.search ? `%${filters.search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const where = tx`
      WHERE true
      ${filters.status ? tx`AND s.status = ${filters.status}::app.school_status` : tx``}
      ${
        pattern
          ? tx`AND (s.name ILIKE ${pattern} OR s.slug ILIKE ${pattern} OR s.email ILIKE ${pattern})`
          : tx``
      }
    `;

    const [{ total }] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.schools s ${where}
    `;
    const rows = await tx<SchoolRow[]>`
      SELECT ${SCHOOL_COLUMNS(tx)}
      FROM app.schools s
      JOIN app.countries c ON c.id = s.country_id
      JOIN app.currencies cur ON cur.id = s.default_currency_id
      ${where}
      ORDER BY s.created_at DESC, s.id
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `;

    const schools = [];
    for (const row of rows) {
      schools.push(toSummary(row, await loadSchoolStats(tx, row.id)));
    }
    return { schools, total: total ?? 0 };
  });
}

async function buildSchoolDetail(tx: TransactionSql, schoolId: string) {
  const school = await loadSchool(tx, schoolId);
  const stats = await loadSchoolStats(tx, schoolId);

  const roleRows = await tx<{ role: string; count: number }[]>`
    SELECT role::text AS role, count(*)::int AS count FROM app.user_roles GROUP BY role
  `;
  const overrideRows = await tx<{ flag_name: string; enabled: boolean }[]>`
    SELECT flag_name, enabled FROM app.feature_flags
  `;
  const overrides = new Map(overrideRows.map((row) => [row.flag_name, row.enabled]));

  return {
    ...toSummary(school, stats),
    emailVerifiedAt: isoOrNull(school.email_verified_at),
    updatedAt: iso(school.updated_at),
    roleCounts: Object.fromEntries(roleRows.map((row) => [row.role, row.count])),
    featureFlags: (Object.entries(FEATURE_FLAGS) as [FlagName, FeatureFlagDefinition][]).map(
      ([name, definition]) => ({
        name,
        description: definition.description,
        defaultValue: definition.defaultValue,
        override: overrides.get(name) ?? null,
      }),
    ),
    allowedTransitions: [...allowedTransitions(school.status)],
  };
}

export async function getSchoolDetail(database: Database, schoolId: string) {
  return withSystemTx(database, (tx) => buildSchoolDetail(tx, schoolId));
}

export interface StatusChangeResult {
  from: SchoolStatus;
  to: SchoolStatus;
  aiEffect: "pause" | "resume" | null;
}

/**
 * Moves a school along its lifecycle, with both audit rows, in one transaction.
 *
 * Re-sending the school's current status is accepted as a no-op on the row: it exists so an
 * operator can retry the AI billing pause/resume (which the route runs after this commits) when
 * the payment provider failed the first time.
 */
export async function changeSchoolStatus(
  database: Database,
  schoolId: string,
  to: SchoolStatus,
  reason: string,
  actor: Actor,
): Promise<StatusChangeResult> {
  return withSystemTx(database, async (tx) => {
    const school = await loadSchool(tx, schoolId, true);
    const from = school.status;

    if (from === to) {
      return { from, to, aiEffect: retryEffect(to) };
    }

    if (!canTransition(from, to)) {
      throw new HTTPException(409, {
        message: `A school cannot move from ${from} to ${to}`,
      });
    }

    await tx`
      UPDATE app.schools SET status = ${to}::app.school_status, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${schoolId}
    `;

    await auditSchoolChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "schools",
      targetId: schoolId,
      oldValues: { status: from },
      newValues: { status: to, reason, source: "platform_console" },
    });

    return { from, to, aiEffect: aiBillingEffect(from, to) };
  });
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export async function setSchoolFeatureFlag(
  database: Database,
  redis: RedisClient | null,
  schoolId: string,
  flag: FlagName,
  enabled: boolean | null,
  actor: Actor,
) {
  const detail = await withSystemTx(database, async (tx) => {
    await loadSchool(tx, schoolId);
    await setTenantScope(tx, schoolId);

    const [existing] = await tx<{ enabled: boolean }[]>`
      SELECT enabled FROM app.feature_flags WHERE flag_name = ${flag}
    `;
    const before = existing?.enabled ?? null;

    if (enabled === null) {
      await tx`DELETE FROM app.feature_flags WHERE flag_name = ${flag}`;
    } else {
      await tx`
        INSERT INTO app.feature_flags (school_id, flag_name, enabled)
        VALUES (${schoolId}, ${flag}, ${enabled})
        ON CONFLICT (school_id, flag_name)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP
      `;
    }

    if (before !== enabled) {
      await auditSchoolChange(tx, schoolId, actor, {
        action: "update",
        targetTable: "feature_flags",
        targetId: schoolId,
        oldValues: { flag, override: before },
        newValues: { flag, override: enabled },
      });
    }

    return buildSchoolDetail(tx, schoolId);
  });

  // The flag cache is TTL-bounded (FLAGS_CACHE_TTL_SECONDS), so this only shortens propagation; a
  // failed delete still converges within the TTL.
  if (redis) {
    await redis.del(cacheKey(schoolId, "flags", flag)).catch(() => undefined);
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

interface PlanRow {
  id: string;
  code: string;
  display_name: string;
  description: string | null;
  is_active: boolean;
  updated_at: Date;
}

interface PriceRow {
  id: string;
  plan_id: string;
  currency_code: string;
  billing_interval: string;
  amount_minor: string;
  minor_unit: number;
  is_active: boolean;
}

async function readPlans(tx: TransactionSql, planId?: string) {
  const plans = await tx<PlanRow[]>`
    SELECT id, code, display_name, description, is_active, updated_at FROM app.plans
    ${planId ? tx`WHERE id = ${planId}` : tx``}
    ORDER BY code
  `;
  const prices = await tx<PriceRow[]>`
    SELECT pp.id, pp.plan_id, cur.code AS currency_code, pp.billing_interval::text AS billing_interval,
           pp.amount_minor::text AS amount_minor, cur.minor_unit::int AS minor_unit, pp.is_active
    FROM app.plan_prices pp
    JOIN app.currencies cur ON cur.id = pp.currency_id
    ${planId ? tx`WHERE pp.plan_id = ${planId}` : tx``}
    ORDER BY cur.code, pp.billing_interval
  `;
  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    displayName: plan.display_name,
    description: plan.description,
    isActive: plan.is_active,
    updatedAt: iso(plan.updated_at),
    prices: prices
      .filter((price) => price.plan_id === plan.id)
      .map((price) => ({
        id: price.id,
        currencyCode: price.currency_code,
        billingInterval: price.billing_interval,
        amountMinor: Number(price.amount_minor),
        minorUnit: price.minor_unit,
        isActive: price.is_active,
      })),
  }));
}

export async function listPlans(database: Database) {
  return withSystemTx(database, (tx) => readPlans(tx));
}

export interface PlanPatch {
  displayName?: string;
  description?: string | null;
  isActive?: boolean;
}

export async function updatePlan(
  database: Database,
  planId: string,
  patch: PlanPatch,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    const [before] = await readPlans(tx, planId);
    if (!before) throw new HTTPException(404, { message: "Plan not found" });

    await tx`
      UPDATE app.plans SET
        display_name = ${patch.displayName ?? before.displayName},
        description = ${patch.description === undefined ? before.description : patch.description || null},
        is_active = ${patch.isActive ?? before.isActive},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${planId}
    `;
    const [after] = await readPlans(tx, planId);

    await auditIn(
      tx,
      actor.schoolId,
      actor.userId,
      {
        action: "update",
        targetTable: "plans",
        targetId: planId,
        oldValues: {
          displayName: before.displayName,
          description: before.description,
          isActive: before.isActive,
        },
        newValues: {
          displayName: after!.displayName,
          description: after!.description,
          isActive: after!.isActive,
        },
      },
      actor.requestId,
    );
    return after!;
  });
}

export async function updatePlanPrice(
  database: Database,
  planId: string,
  priceId: string,
  isActive: boolean,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    const rows = await tx<{ is_active: boolean }[]>`
      SELECT is_active FROM app.plan_prices WHERE id = ${priceId} AND plan_id = ${planId} FOR UPDATE
    `;
    const before = rows[0];
    if (!before) throw new HTTPException(404, { message: "Plan price not found" });

    if (before.is_active !== isActive) {
      await tx`
        UPDATE app.plan_prices SET is_active = ${isActive}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${priceId}
      `;
      await auditIn(
        tx,
        actor.schoolId,
        actor.userId,
        {
          action: "update",
          targetTable: "plan_prices",
          targetId: priceId,
          oldValues: { isActive: before.is_active },
          newValues: { isActive },
        },
        actor.requestId,
      );
    }
    const [plan] = await readPlans(tx, planId);
    return plan!;
  });
}

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

interface SettingRow {
  key: string;
  description: string;
  value_type: "boolean" | "integer" | "text";
  boolean_value: boolean | null;
  integer_value: string | null;
  text_value: string | null;
  sensitivity: "public" | "internal";
  is_mutable: boolean;
  requires_restart: boolean;
  updated_at: Date;
}

function toSetting(row: SettingRow) {
  const value =
    row.value_type === "boolean"
      ? row.boolean_value!
      : row.value_type === "integer"
        ? Number(row.integer_value)
        : row.text_value!;
  return {
    key: row.key,
    description: row.description,
    valueType: row.value_type,
    value,
    sensitivity: row.sensitivity,
    isMutable: row.is_mutable,
    requiresRestart: row.requires_restart,
    updatedAt: iso(row.updated_at),
  };
}

const SETTING_COLUMNS = (tx: TransactionSql) => tx`
  key, description, value_type::text AS value_type, boolean_value,
  integer_value::text AS integer_value, text_value, sensitivity::text AS sensitivity,
  is_mutable, requires_restart, updated_at
`;

export async function listPlatformSettings(database: Database) {
  return withSystemTx(database, async (tx) => {
    const rows = await tx<SettingRow[]>`
      SELECT ${SETTING_COLUMNS(tx)} FROM app.platform_settings ORDER BY key
    `;
    return rows.map(toSetting);
  });
}

/**
 * Updates one setting's value. Only rows seeded `is_mutable` may change at runtime, and the value
 * must match the row's declared type -- the table's own CHECK would reject a mismatch, but a 400
 * naming the expected type is a better answer than a 500.
 */
export async function updatePlatformSetting(
  database: Database,
  key: string,
  value: boolean | number | string,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    const rows = await tx<SettingRow[]>`
      SELECT ${SETTING_COLUMNS(tx)} FROM app.platform_settings WHERE key = ${key} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new HTTPException(404, { message: "Setting not found" });
    if (!row.is_mutable) {
      throw new HTTPException(409, { message: "This setting cannot be changed at runtime" });
    }

    const expected =
      row.value_type === "integer" ? "number" : row.value_type === "text" ? "string" : "boolean";
    if (typeof value !== expected) {
      throw new HTTPException(400, { message: `Setting ${key} expects a ${row.value_type} value` });
    }

    const before = toSetting(row);
    await tx`
      UPDATE app.platform_settings SET
        boolean_value = ${row.value_type === "boolean" ? (value as boolean) : null},
        integer_value = ${row.value_type === "integer" ? String(value) : null}::bigint,
        text_value = ${row.value_type === "text" ? (value as string) : null},
        updated_at = CURRENT_TIMESTAMP
      WHERE key = ${key}
    `;
    const [updated] = await tx<SettingRow[]>`
      SELECT ${SETTING_COLUMNS(tx)} FROM app.platform_settings WHERE key = ${key}
    `;
    const after = toSetting(updated!);

    // platform_settings has a uuid id, but its natural key is `key`; record both for readers.
    const [{ id }] = await tx<
      { id: string }[]
    >`SELECT id FROM app.platform_settings WHERE key = ${key}`;
    await auditIn(
      tx,
      actor.schoolId,
      actor.userId,
      {
        action: "update",
        targetTable: "platform_settings",
        targetId: id!,
        oldValues: { key, value: before.value },
        newValues: { key, value: after.value },
      },
      actor.requestId,
    );
    return after;
  });
}

// ---------------------------------------------------------------------------
// Sales inquiries
// ---------------------------------------------------------------------------

interface InquiryRow {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  school_name: string;
  job_title: string | null;
  country: string | null;
  student_count: number | null;
  message: string | null;
  source_path: string | null;
  status: InquiryStatus;
  internal_notes: string | null;
  notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const INQUIRY_COLUMNS = (tx: TransactionSql) => tx`
  id, full_name, email, phone, school_name, job_title, country, student_count, message,
  source_path, status, internal_notes, notified_at, created_at, updated_at
`;

function toInquiry(row: InquiryRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    schoolName: row.school_name,
    jobTitle: row.job_title,
    country: row.country,
    studentCount: row.student_count,
    message: row.message,
    sourcePath: row.source_path,
    status: row.status,
    internalNotes: row.internal_notes,
    notifiedAt: isoOrNull(row.notified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface InquiryListFilters {
  status?: InquiryStatus;
  search?: string;
  limit: number;
  offset: number;
}

/** "Talk to us" inquiries, newest first. A global table, so one query covers every one. */
export async function listInquiries(database: Database, filters: InquiryListFilters) {
  return withSystemTx(database, async (tx) => {
    const pattern = filters.search ? `%${filters.search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const where = tx`
      WHERE true
      ${filters.status ? tx`AND status = ${filters.status}` : tx``}
      ${
        pattern
          ? tx`AND (full_name ILIKE ${pattern} OR email ILIKE ${pattern}
                    OR school_name ILIKE ${pattern})`
          : tx``
      }
    `;
    const [{ total }] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.sales_inquiries ${where}
    `;
    const [{ new_count }] = await tx<{ new_count: number }[]>`
      SELECT count(*)::int AS new_count FROM app.sales_inquiries WHERE status = 'new'
    `;
    const rows = await tx<InquiryRow[]>`
      SELECT ${INQUIRY_COLUMNS(tx)} FROM app.sales_inquiries ${where}
      ORDER BY created_at DESC, id
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `;
    return { inquiries: rows.map(toInquiry), total: total ?? 0, newCount: new_count ?? 0 };
  });
}

/**
 * Moves an inquiry along the sales pipeline and/or edits the team's internal notes. A global row,
 * so audited in the operator's home school only (see the file header).
 */
export async function updateInquiry(
  database: Database,
  inquiryId: string,
  patch: { status?: InquiryStatus; internalNotes?: string | null },
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    const [before] = await tx<InquiryRow[]>`
      SELECT ${INQUIRY_COLUMNS(tx)} FROM app.sales_inquiries WHERE id = ${inquiryId} FOR UPDATE
    `;
    if (!before) throw new HTTPException(404, { message: "Inquiry not found" });

    const notes =
      patch.internalNotes === undefined ? before.internal_notes : patch.internalNotes || null;
    const [after] = await tx<InquiryRow[]>`
      UPDATE app.sales_inquiries SET
        status = ${patch.status ?? before.status},
        internal_notes = ${notes},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${inquiryId}
      RETURNING ${INQUIRY_COLUMNS(tx)}
    `;

    await auditIn(
      tx,
      actor.schoolId,
      actor.userId,
      {
        action: "update",
        targetTable: "sales_inquiries",
        targetId: inquiryId,
        oldValues: { status: before.status, internalNotes: before.internal_notes },
        newValues: { status: after!.status, internalNotes: after!.internal_notes },
      },
      actor.requestId,
    );
    return toInquiry(after!);
  });
}

// ---------------------------------------------------------------------------
// School members
// ---------------------------------------------------------------------------

export interface SchoolMemberFilters {
  role?: Role;
  status?: MemberStatus;
  search?: string;
  limit: number;
  offset: number;
}

interface MemberRow {
  id: string;
  display_name: string | null;
  email: string | null;
  status: MemberStatus;
  created_at: Date;
  last_login_at: Date | null;
  roles: string[] | null;
  member_codes: string[] | null;
  student_id: string | null;
  admission_number: string | null;
  student_status: string | null;
  employee_number: string | null;
  employment_status: string | null;
  classes: string[] | null;
  guardians: { userId: string; displayName: string | null; relationship: string }[] | null;
  children:
    | {
        studentId: string;
        userId: string;
        name: string;
        admissionNumber: string;
        relationship: string;
      }[]
    | null;
}

function toMember(row: MemberRow) {
  return {
    userId: row.id,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    roles: row.roles ?? [],
    memberCodes: row.member_codes ?? [],
    createdAt: iso(row.created_at),
    lastLoginAt: isoOrNull(row.last_login_at),
    student:
      row.student_id && row.admission_number && row.student_status
        ? {
            studentId: row.student_id,
            admissionNumber: row.admission_number,
            status: row.student_status,
            classes: row.classes ?? [],
            guardians: row.guardians ?? [],
          }
        : null,
    teacher:
      row.employee_number && row.employment_status
        ? { employeeNumber: row.employee_number, employmentStatus: row.employment_status }
        : null,
    children: row.children ?? [],
  };
}

/**
 * One school's accounts, paged, with each one's roles, member codes (STU/TCH/PAR, 000140) and
 * role-specific records: admission number, classes and guardians for students; employee number for
 * teachers; linked children for parents.
 *
 * A single school, so its scope is armed once and every query below stays inside it. Reading a
 * school's roster is personal data leaving that tenant, so it is audited like a change (see the
 * file header): a system row in the school and an attributed row at the operator's home.
 */
export async function listSchoolMembers(
  database: Database,
  schoolId: string,
  filters: SchoolMemberFilters,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    await loadSchool(tx, schoolId);
    await setTenantScope(tx, schoolId);

    const pattern = filters.search ? `%${filters.search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const where = tx`
      WHERE true
      ${filters.status ? tx`AND u.status = ${filters.status}::app.user_status` : tx``}
      ${
        filters.role
          ? tx`AND EXISTS (SELECT 1 FROM app.user_roles r
                           WHERE r.user_id = u.id AND r.role = ${filters.role}::app.user_role)`
          : tx``
      }
      ${
        pattern
          ? tx`AND (u.display_name ILIKE ${pattern} OR u.email ILIKE ${pattern}
                    OR st.admission_number ILIKE ${pattern}
                    OR concat_ws(' ', st.first_name, st.last_name) ILIKE ${pattern}
                    OR t.employee_number ILIKE ${pattern}
                    OR EXISTS (SELECT 1 FROM app.member_codes mc
                               WHERE mc.user_id = u.id AND mc.code ILIKE ${pattern}))`
          : tx``
      }
    `;
    // NULL, not '', for an account with no student record.
    const studentName = tx`NULLIF(concat_ws(' ', st.first_name, st.middle_name, st.last_name), '')`;
    const from = tx`
      FROM app.users u
      LEFT JOIN app.students st ON st.user_id = u.id
      LEFT JOIN app.teachers t ON t.user_id = u.id
    `;

    const [{ total }] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total ${from} ${where}
    `;
    const [{ member_count }] = await tx<{ member_count: number }[]>`
      SELECT count(*)::int AS member_count FROM app.users
    `;
    const roleRows = await tx<{ role: string; count: number }[]>`
      SELECT role::text AS role, count(*)::int AS count FROM app.user_roles GROUP BY role
    `;

    // Page first, then attach the per-member lists, so the subqueries run for `limit` rows only.
    const rows = await tx<MemberRow[]>`
      WITH page AS (
        SELECT u.id,
               COALESCE(u.display_name, ${studentName}) AS display_name,
               u.email, u.status::text AS status, u.created_at, u.last_login_at,
               st.id AS student_id, st.admission_number, st.status::text AS student_status,
               t.employee_number, t.employment_status::text AS employment_status
        ${from} ${where}
        ORDER BY lower(COALESCE(u.display_name, ${studentName}, u.email)), u.id
        LIMIT ${filters.limit} OFFSET ${filters.offset}
      )
      SELECT page.*,
        ARRAY(SELECT r.role::text FROM app.user_roles r
              WHERE r.user_id = page.id ORDER BY r.role) AS roles,
        ARRAY(SELECT mc.code FROM app.member_codes mc
              WHERE mc.user_id = page.id ORDER BY mc.kind) AS member_codes,
        ARRAY(SELECT c.code FROM app.enrollments e
              JOIN app.classes c ON c.id = e.class_id
              WHERE e.student_id = page.student_id AND e.status = 'active' AND c.status = 'active'
              ORDER BY c.code) AS classes,
        (SELECT json_agg(json_build_object(
                  'userId', pu.id, 'displayName', pu.display_name,
                  'relationship', l.relationship::text) ORDER BY pu.display_name, pu.id)
         FROM app.parent_child_links l
         JOIN app.users pu ON pu.id = l.parent_user_id
         WHERE l.student_id = page.student_id) AS guardians,
        (SELECT json_agg(json_build_object(
                  'studentId', cs.id, 'userId', cs.user_id,
                  'name', concat_ws(' ', cs.first_name, cs.last_name),
                  'admissionNumber', cs.admission_number,
                  'relationship', l.relationship::text) ORDER BY cs.first_name, cs.id)
         FROM app.parent_child_links l
         JOIN app.students cs ON cs.id = l.student_id
         WHERE l.parent_user_id = page.id) AS children
      FROM page
      ORDER BY lower(COALESCE(page.display_name, page.email)), page.id
    `;

    await auditSchoolChange(tx, schoolId, actor, {
      action: "read",
      targetTable: "users",
      targetId: schoolId,
      newValues: {
        role: filters.role ?? null,
        status: filters.status ?? null,
        search: filters.search ?? null,
        limit: filters.limit,
        offset: filters.offset,
        returned: rows.length,
      },
    });

    return {
      members: rows.map(toMember),
      total: total ?? 0,
      memberCount: member_count ?? 0,
      roleCounts: Object.fromEntries(roleRows.map((row) => [row.role, row.count])),
    };
  });
}

// ---------------------------------------------------------------------------
// User lookup
// ---------------------------------------------------------------------------

/**
 * Finds every account with this email across all schools -- identity is per-school (ADR-0008), so
 * one person may have several. A support tool: exact match on the normalized email only, never a
 * substring search across tenants.
 */
export async function lookupUserByEmail(database: Database, email: string) {
  const normalized = email.trim().toLowerCase();
  return withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string; name: string; status: SchoolStatus }[]>`
      SELECT id, name, status::text AS status FROM app.schools ORDER BY name
    `;
    const matches = [];
    for (const school of schools) {
      await setTenantScope(tx, school.id);
      const users = await tx<
        {
          id: string;
          display_name: string | null;
          email: string;
          status: string;
          last_login_at: Date | null;
          roles: string[] | null;
        }[]
      >`
        SELECT u.id, u.display_name, u.email, u.status::text AS status, u.last_login_at,
               array_remove(array_agg(r.role::text ORDER BY r.role), NULL) AS roles
        FROM app.users u
        LEFT JOIN app.user_roles r ON r.user_id = u.id
        WHERE u.normalized_email = ${normalized}
        GROUP BY u.id
      `;
      for (const user of users) {
        matches.push({
          schoolId: school.id,
          schoolName: school.name,
          schoolStatus: school.status,
          userId: user.id,
          displayName: user.display_name,
          email: user.email,
          status: user.status,
          roles: user.roles ?? [],
          lastLoginAt: isoOrNull(user.last_login_at),
        });
      }
    }
    return matches;
  });
}
