import { ERROR_CODES } from "@studafy/constants";
import postgres from "postgres";

import { CodedHttpException } from "../../coded-http-exception";
import { setTenantScope, withSystemTx, withTenantTx } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { getLocalizedMessage } from "../../middleware/locale";

import type { Database, DatabasePools } from "../../db/client";
import type { AuditEntry } from "../../middleware/auditEmitter";
import type { SupportedLocale } from "../../middleware/locale";
import type { ErrorCode } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * Who is acting on a school's license, and how their writes are scoped and audited.
 *
 * A school admin acts inside their own school: an ordinary tenant transaction as studafy_app, one
 * audit row attributed to them. A super admin acts on a school that is not theirs: a system
 * transaction (studafy_admin) scoped to the target school, and -- the platform console's convention
 * (modules/platform/service.ts) -- two audit rows, one in the target school with a NULL actor and one
 * in the operator's home school with the operator as actor, because audit_logs.actor_id is a
 * composite foreign key into the actor's own school.
 */
export interface LicenseActor {
  kind: "school" | "platform";
  userId: string;
  /** The actor's own school: the school itself for a school admin, the home school for a super admin. */
  homeSchoolId: string;
  requestId?: string;
  locale?: SupportedLocale;
}

/** Run `fn` in a transaction scoped to `schoolId`, as the actor. */
export async function inSchool<T>(
  database: Database | DatabasePools,
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (actor.kind === "school") {
    return withTenantTx(
      database,
      { schoolId, userId: actor.userId, requestId: actor.requestId },
      fn,
    );
  }
  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, schoolId, actor.requestId);
    await tx`SELECT set_config('app.user_id', '', true)`;
    return fn(tx);
  });
}

/**
 * Write an audit row for a change in `schoolId`. Leaves the transaction scoped to `schoolId` with the
 * same actor GUC it found, so callers can keep writing after it.
 */
export async function auditLicenseChange(
  tx: TransactionSql,
  schoolId: string,
  actor: LicenseActor,
  entry: AuditEntry,
): Promise<void> {
  if (actor.kind === "school") {
    await emitAuditLog(tx, entry);
    return;
  }

  if (actor.homeSchoolId === schoolId) {
    await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
    await emitAuditLog(tx, entry);
    await tx`SELECT set_config('app.user_id', '', true)`;
    return;
  }

  // The affected school's system-attributed row, then the operator's own row in their home school.
  await emitAuditLog(tx, entry);
  await setTenantScope(tx, actor.homeSchoolId, actor.requestId);
  await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
  await emitAuditLog(tx, entry);
  await setTenantScope(tx, schoolId, actor.requestId);
  await tx`SELECT set_config('app.user_id', '', true)`;
}

export function licenseError(
  status: 402 | 403 | 404 | 409 | 422,
  code: ErrorCode,
  locale: SupportedLocale = "en",
): CodedHttpException {
  return new CodedHttpException(status, code, getLocalizedMessage(code, locale));
}

/**
 * The database's refusals, as coded errors. The seat cap, eligibility and tier rules live in
 * triggers and constraints (migration 000163), so a write that breaks one surfaces here whatever
 * path it came from.
 */
const CONSTRAINT_ERRORS: Record<string, [409 | 422, ErrorCode]> = {
  ck_license_seats_capacity: [409, ERROR_CODES.LICENSE_SEAT_LIMIT_REACHED],
  ck_license_seats_eligible: [422, ERROR_CODES.LICENSE_SEAT_NOT_ELIGIBLE],
  ck_license_seats_license_open: [409, ERROR_CODES.LICENSE_NOT_EDITABLE],
  uq_license_seats_active_person: [409, ERROR_CODES.LICENSE_SEAT_LIMIT_REACHED],
  ck_school_licenses_seats_assigned: [409, ERROR_CODES.LICENSE_SEATS_BELOW_ASSIGNED],
  ck_school_licenses_tier_audience: [422, ERROR_CODES.LICENSE_TIER_INVALID],
  ck_school_licenses_student_tier: [422, ERROR_CODES.LICENSE_TIER_INVALID],
  ck_school_licenses_teacher_tier: [422, ERROR_CODES.LICENSE_TIER_INVALID],
  ck_school_licenses_parent_tier: [422, ERROR_CODES.LICENSE_TIER_INVALID],
  ck_school_licenses_family_plus: [422, ERROR_CODES.LICENSE_TIER_INVALID],
  ck_school_licenses_period: [422, ERROR_CODES.VALIDATION_FAILED],
  uq_school_licenses_one_active: [409, ERROR_CODES.LICENSE_ALREADY_ACTIVE],
};

/** Re-throw a known constraint refusal as its coded error; anything else unchanged. */
export function rethrowLicenseDbError(err: unknown, locale: SupportedLocale = "en"): never {
  if (err instanceof postgres.PostgresError && err.constraint_name) {
    const mapped = CONSTRAINT_ERRORS[err.constraint_name];
    if (mapped) throw licenseError(mapped[0], mapped[1], locale);
  }
  throw err;
}
