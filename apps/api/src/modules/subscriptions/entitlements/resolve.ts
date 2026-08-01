import { LIVE_STATUSES } from "@studafy/billing";

import { GENESIS_ENTITLEMENTS_VERSION } from "./version";

import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * Entitlement resolution from the database (ST-133).
 *
 * Ceilings, not counters. This module answers "what is this tenant allowed" -- is the school active,
 * is the student's AI add-on active, what are the plan-level caps. It deliberately does not meter
 * usage or decrement anything; per-request quota consumption is ST-155's job and will consume this
 * output rather than live here.
 *
 * `app.subscriptions` and `app.ai_subscriptions` remain the single source of truth for entitlement
 * *state*. `app.entitlement_versions` is the single source of truth for staleness detection. This
 * query reads all three, but writes none of them.
 */

/**
 * The default `app.subscriptions.student_cap`, mirrored from `db/migrations/000038`.
 *
 * Used only for a school with no subscription row at all, which is the same defensive fallback
 * `readSubscriptionStatus` has always taken for `status`. A tenant mid-provisioning should not be
 * refused service by a resolver, and 50 is what the column would have given it anyway.
 */
const DEFAULT_STUDENT_CAP = 50;

export interface EntitlementQuotas {
  /**
   * The school's enrolled-student ceiling, from `app.subscriptions.student_cap`.
   *
   * The only quota ceiling this schema has -- `app.plans` is pure metadata, with no tier or limit
   * columns. `planCode` is carried alongside so per-plan defaults can be layered on later without
   * changing this shape.
   *
   * Not a live count. `checkStudentCap` (modules/students/services/student-cap.ts) counts enrolled
   * students inside the write transaction and must keep doing so -- a cached ceiling combined with an
   * uncached count is a cap that can be raced past.
   */
  studentCap: number;
}

export interface SchoolEntitlement {
  schoolId: string;
  /** The `entitlement_versions` counter for this school. The JWT staleness authority. */
  version: number;
  subscriptionId: string | null;
  status: SubscriptionStatus;
  /** `status` is one of `LIVE_STATUSES`. */
  active: boolean;
  planCode: string | null;
  quotas: EntitlementQuotas;
  /** ISO-8601, or null when the school has no subscription row. */
  currentPeriodEnd: string | null;
}

export interface AiEntitlement {
  schoolId: string;
  studentId: string;
  /** The `entitlement_versions` counter for this student. */
  version: number;
  /**
   * The school version this verdict was computed against.
   *
   * `ent:ai:{studentId}` is not school-prefixed, so a school-level change cannot find and delete its
   * students' AI entries. Worse, a school transition that cascades no AI rows -- `active` to
   * `past_due`, say, where `resolveAiCascade` returns null -- changes the *effective* AI answer while
   * touching zero `ai_subscriptions` rows and emitting zero AI events. The reader therefore
   * revalidates this against the school entry's version and treats a mismatch as a miss. See
   * ./cache.ts.
   */
  schoolVersion: number;
  status: SubscriptionStatus | null;
  /** Structurally false whenever the school is not active. */
  active: boolean;
}

interface ResolutionRow {
  subscription_id: string | null;
  school_status: SubscriptionStatus | null;
  school_active: boolean | null;
  student_cap: number | null;
  current_period_end: Date | null;
  plan_code: string | null;
  ai_status: SubscriptionStatus | null;
  ai_active: boolean;
  school_version: string;
  ai_version: string;
}

/**
 * One row carrying every entitlement fact for a school, and optionally one student's AI add-on.
 *
 * The school-inactive-implies-AI-inactive rule is a boolean AND over a single joined row rather than
 * two independent lookups that could disagree. That is the point: an AI verdict computed from
 * `ai_subscriptions.status` alone would read `active` for a student whose school was canceled
 * moments ago, and no amount of ordering between two separate queries closes that gap.
 *
 * `LIVE_STATUSES` comes from @studafy/billing so "live" is defined in exactly one place. The
 * `status::text = ANY(${array})` form is the one already proven in the billing cascade.
 *
 * `app.plans` is global and RLS-free, so the join is safe. It is a plain JOIN rather than a LEFT JOIN
 * because `fk_subscriptions_plan` is RESTRICT -- a subscription cannot reference a plan that is not
 * there.
 */
function resolutionQuery(tx: TransactionSql, studentId: string | null) {
  return tx<ResolutionRow[]>`
    SELECT
      s.id::text AS subscription_id,
      s.status::text AS school_status,
      (s.status::text = ANY(${[...LIVE_STATUSES]})) AS school_active,
      s.student_cap AS student_cap,
      s.current_period_end AS current_period_end,
      p.code AS plan_code,
      ai.status::text AS ai_status,
      COALESCE(
        s.status::text = ANY(${[...LIVE_STATUSES]}) AND ai.status::text = ANY(${[...LIVE_STATUSES]}),
        false
      ) AS ai_active,
      COALESCE(ev_school.version, ${GENESIS_ENTITLEMENTS_VERSION})::text AS school_version,
      COALESCE(ev_ai.version, ${GENESIS_ENTITLEMENTS_VERSION})::text AS ai_version
    FROM app.subscriptions AS s
    JOIN app.plans AS p
      ON p.id = s.plan_id
    LEFT JOIN app.ai_subscriptions AS ai
      ON ai.school_id = s.school_id
     AND ai.student_id = ${studentId}::uuid
    LEFT JOIN app.entitlement_versions AS ev_school
      ON ev_school.school_id = s.school_id
     AND ev_school.subject_type = 'school'
     AND ev_school.subject_id = s.school_id
    LEFT JOIN app.entitlement_versions AS ev_ai
      ON ev_ai.school_id = s.school_id
     AND ev_ai.subject_type = 'ai'
     AND ev_ai.subject_id = ${studentId}::uuid
    WHERE s.school_id = current_setting('app.school_id')::uuid
  `;
}

/**
 * The school's entitlement, as of this transaction.
 *
 * A school with no subscription row resolves to a live `trialing` at the genesis version, mirroring
 * the fallback `readSubscriptionStatus` has always applied: a tenant whose provisioning has not yet
 * written the row is mid-setup, not unentitled.
 */
export async function resolveSchoolEntitlement(
  tx: TransactionSql,
  schoolId: string,
): Promise<SchoolEntitlement> {
  const [row] = await resolutionQuery(tx, null);

  if (!row) {
    return {
      schoolId,
      version: GENESIS_ENTITLEMENTS_VERSION,
      subscriptionId: null,
      status: "trialing",
      active: true,
      planCode: null,
      quotas: { studentCap: DEFAULT_STUDENT_CAP },
      currentPeriodEnd: null,
    };
  }

  return {
    schoolId,
    version: Number(row.school_version),
    subscriptionId: row.subscription_id,
    status: row.school_status ?? "trialing",
    active: row.school_active ?? false,
    planCode: row.plan_code,
    quotas: { studentCap: row.student_cap ?? DEFAULT_STUDENT_CAP },
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
  };
}

/**
 * One student's AI entitlement, and the school entitlement it was computed against.
 *
 * Both are returned from the one query so a caller can write both cache entries from a single
 * database round trip, with a `schoolVersion` on the AI entry that provably matches the school entry
 * written beside it.
 */
export async function resolveAiEntitlement(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<{ ai: AiEntitlement; school: SchoolEntitlement }> {
  const [row] = await resolutionQuery(tx, studentId);

  if (!row) {
    const school = await resolveSchoolEntitlement(tx, schoolId);
    return {
      school,
      ai: {
        schoolId,
        studentId,
        version: GENESIS_ENTITLEMENTS_VERSION,
        schoolVersion: school.version,
        status: null,
        // No subscription row means no AI add-on was ever bought. Absent is not entitled.
        active: false,
      },
    };
  }

  const school: SchoolEntitlement = {
    schoolId,
    version: Number(row.school_version),
    subscriptionId: row.subscription_id,
    status: row.school_status ?? "trialing",
    active: row.school_active ?? false,
    planCode: row.plan_code,
    quotas: { studentCap: row.student_cap ?? DEFAULT_STUDENT_CAP },
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
  };

  return {
    school,
    ai: {
      schoolId,
      studentId,
      version: Number(row.ai_version),
      schoolVersion: school.version,
      status: row.ai_status,
      active: row.ai_active,
    },
  };
}
