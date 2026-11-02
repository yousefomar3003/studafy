import { LIVE_STATUSES } from "@studafy/billing";

import { GENESIS_ENTITLEMENTS_VERSION, readEntitlementVersion } from "./version";

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
  /**
   * The student's user id, or null when no student has this id in the school. Feature resolution
   * (modules/features) starts from a student id on the AI routes and needs the person's user id to
   * read their other grants. An entry cached before this field existed has it `undefined` and is
   * re-resolved -- see service.ts.
   */
  userId: string | null;
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
  /**
   * The AI subscription's billing window, ISO-8601, or null when the student has no AI subscription
   * row. ST-155's quota meter keys its monthly token budget on this window rather than a calendar
   * month: the budget must reset at the renewal that starts a fresh billing cycle, which a calendar
   * key cannot express for a subscription renewed mid-month.
   */
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
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
  ai_period_start: Date | null;
  ai_period_end: Date | null;
  student_user_id: string | null;
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
      ai.current_period_start AS ai_period_start,
      ai.current_period_end AS ai_period_end,
      app.student_user_id(${studentId}::uuid)::text AS student_user_id,
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
 * A school with no subscription row resolves to a live `trialing`, mirroring the fallback
 * `readSubscriptionStatus` has always applied: a tenant whose provisioning has not yet written the
 * row is mid-setup, not unentitled. Its version still comes from `app.entitlement_versions` (genesis
 * when absent), never assumed: closing a school bumps the counter whether or not the school ever
 * subscribed, and the JWT staleness check must see that bump — the same counter session issuance
 * stamps into `entitlements_ver`.
 */
export async function resolveSchoolEntitlement(
  tx: TransactionSql,
  schoolId: string,
): Promise<SchoolEntitlement> {
  const [row] = await resolutionQuery(tx, null);

  if (!row) {
    return {
      schoolId,
      version: await readEntitlementVersion(tx, "school", schoolId),
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
    // app.student_user_id, not app.students: the resolver runs with no acting user, and the
    // students table's role-scope policy shows a userless transaction nothing (000161).
    const [student] = await tx<{ user_id: string | null }[]>`
      SELECT app.student_user_id(${studentId}::uuid)::text AS user_id
    `;
    return {
      school,
      ai: {
        schoolId,
        studentId,
        userId: student?.user_id ?? null,
        version: GENESIS_ENTITLEMENTS_VERSION,
        schoolVersion: school.version,
        status: null,
        // No subscription row means no AI add-on was ever bought. Absent is not entitled.
        active: false,
        currentPeriodStart: null,
        currentPeriodEnd: null,
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
      userId: row.student_user_id,
      version: Number(row.ai_version),
      schoolVersion: school.version,
      status: row.ai_status,
      active: row.ai_active,
      currentPeriodStart: row.ai_period_start?.toISOString() ?? null,
      currentPeriodEnd: row.ai_period_end?.toISOString() ?? null,
    },
  };
}

/** One personal subscription, as the feature resolver needs it. */
export interface UserSubscriptionGrant {
  id: string;
  /** The tier's `app.plans.code`. */
  planCode: string;
  provider: string;
  status: SubscriptionStatus;
  /** `status` is one of `LIVE_STATUSES`. Not AND-ed with the school: the feature resolver does that. */
  live: boolean;
  autoRenew: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

/**
 * One person's grants outside the AI add-on (docs/billing/feature-licensing.md): their personal
 * subscriptions and their school-license seats. Cached as `ent:usr:{userId}`.
 */
export interface UserEntitlement {
  schoolId: string;
  userId: string;
  /** The `entitlement_versions` counter for this user (subject `user`). */
  version: number;
  /** The school version this was computed against; see `AiEntitlement.schoolVersion`. */
  schoolVersion: number;
  /**
   * The person's `app.students.id` in this school, or null for a non-student. The AI add-on is
   * keyed by student id, so feature resolution starting from a user id needs it.
   */
  studentId: string | null;
  subscriptions: UserSubscriptionGrant[];
  /**
   * The person's assigned seats on licenses that have been in force (active, suspended, expired or
   * cancelled -- not draft or awaiting payment). Whether a seat covers them *now* depends on the
   * clock as well as the status, so the grant adapter decides at read time from these dates; an entry
   * cached before a license's end date stops covering exactly at it.
   */
  seats: LicenseSeatGrant[];
}

/** One assigned seat, as the feature resolver needs it. */
export interface LicenseSeatGrant {
  seatId: string;
  licenseId: string;
  audience: "student" | "teacher" | "parent";
  /** The license's tier for the seat's audience (`app.plans.code`), or null if it has none. */
  planCode: string | null;
  licenseStatus: "active" | "expired" | "cancelled" | "suspended";
  startsAt: string;
  endsAt: string;
}

/**
 * How many of a person's subscriptions are read, newest period first. Ended ones are kept so a
 * lapsed feature answers FEATURE_EXPIRED rather than FEATURE_NOT_INCLUDED; a person does not hold
 * anywhere near this many.
 */
const USER_SUBSCRIPTION_READ_LIMIT = 20;

interface LicenseSeatRow {
  seat_id: string;
  license_id: string;
  audience: LicenseSeatGrant["audience"];
  plan_code: string | null;
  license_status: LicenseSeatGrant["licenseStatus"];
  starts_at: Date;
  ends_at: Date;
}

interface UserSubscriptionRow {
  id: string;
  plan_code: string;
  provider: string;
  status: SubscriptionStatus;
  live: boolean;
  auto_renew: boolean;
  current_period_start: Date;
  current_period_end: Date;
}

/**
 * One person's grants, and the versions they were computed against, in one transaction.
 *
 * Personal subscriptions and license seats are read together so that everything a person holds
 * outside the AI add-on is cached and invalidated as one entry.
 */
export async function resolveUserEntitlement(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<UserEntitlement> {
  const [head] = await tx<
    { student_id: string | null; user_version: string; school_version: string }[]
  >`
    SELECT
      -- The helper, not app.students: see resolveAiEntitlement.
      app.user_student_id(${userId}::uuid)::text AS student_id,
      COALESCE(
        (SELECT ev.version
           FROM app.entitlement_versions AS ev
          WHERE ev.school_id = current_setting('app.school_id')::uuid
            AND ev.subject_type = 'user'
            AND ev.subject_id = ${userId}::uuid),
        ${GENESIS_ENTITLEMENTS_VERSION}
      )::text AS user_version,
      COALESCE(
        (SELECT ev.version
           FROM app.entitlement_versions AS ev
          WHERE ev.school_id = current_setting('app.school_id')::uuid
            AND ev.subject_type = 'school'
            AND ev.subject_id = current_setting('app.school_id')::uuid),
        ${GENESIS_ENTITLEMENTS_VERSION}
      )::text AS school_version
  `;

  const rows = await tx<UserSubscriptionRow[]>`
    SELECT
      us.id::text AS id,
      p.code AS plan_code,
      us.provider,
      us.status::text AS status,
      (us.status::text = ANY(${[...LIVE_STATUSES]})) AS live,
      us.auto_renew,
      us.current_period_start,
      us.current_period_end
    FROM app.user_subscriptions AS us
    JOIN app.plans AS p
      ON p.id = us.plan_id
    WHERE us.school_id = current_setting('app.school_id')::uuid
      AND us.user_id = ${userId}::uuid
    ORDER BY us.current_period_end DESC
    LIMIT ${USER_SUBSCRIPTION_READ_LIMIT}
  `;

  // A person holds at most one active seat per audience per license; across licenses over time the
  // list stays short, and only seats still assigned are read.
  const seats = await tx<LicenseSeatRow[]>`
    SELECT
      s.id::text AS seat_id,
      l.id::text AS license_id,
      s.audience,
      p.code AS plan_code,
      l.status AS license_status,
      l.starts_at,
      l.ends_at
    FROM app.license_seats AS s
    JOIN app.school_licenses AS l
      ON l.id = s.license_id
     AND l.school_id = s.school_id
    LEFT JOIN app.plans AS p
      ON p.id = CASE s.audience
                  WHEN 'student' THEN l.student_plan_id
                  WHEN 'teacher' THEN l.teacher_plan_id
                  ELSE l.parent_plan_id
                END
    WHERE s.school_id = current_setting('app.school_id')::uuid
      AND s.user_id = ${userId}::uuid
      AND s.unassigned_at IS NULL
      AND l.status IN ('active', 'suspended', 'expired', 'cancelled')
    ORDER BY l.ends_at DESC
  `;

  return {
    schoolId,
    userId,
    version: Number(head?.user_version ?? GENESIS_ENTITLEMENTS_VERSION),
    schoolVersion: Number(head?.school_version ?? GENESIS_ENTITLEMENTS_VERSION),
    studentId: head?.student_id ?? null,
    subscriptions: rows.map((row) => ({
      id: row.id,
      planCode: row.plan_code,
      provider: row.provider,
      status: row.status,
      live: row.live,
      autoRenew: row.auto_renew,
      currentPeriodStart: row.current_period_start.toISOString(),
      currentPeriodEnd: row.current_period_end.toISOString(),
    })),
    seats: seats.map((row) => ({
      seatId: row.seat_id,
      licenseId: row.license_id,
      audience: row.audience,
      planCode: row.plan_code,
      licenseStatus: row.license_status,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
    })),
  };
}
