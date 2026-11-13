import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { pipelinePerSchool, withSystemTx } from "../../db/tenant-tx";
import { auditLicenseChange, licenseError } from "../licensing/context";
import { publishUserEntitlementChanges } from "../subscriptions/entitlements/entitlement-change-publisher";

import type { GrantKind, GrantListFilter, GrantState } from "./grants-schemas";
import type { Database, DatabasePools } from "../../db/client";
import type { LicenseActor } from "../licensing/context";
import type { TransactionSql } from "postgres";

/**
 * Manual grants (db/migrations/000211): storage caps and feature tiers Studafy staff give a school or
 * a person by hand, usually after a cash or transfer payment.
 *
 * Nothing here decides coverage: the quota check (storage/quota-service.ts) and the feature
 * resolver (features/grants.ts) read the rows and their dates directly, so a grant starts and ends
 * on its own. Granting or revoking a tier bumps the person's entitlement version in the same
 * transaction (and the route invalidates their cache entry after commit), so the apps unlock or lock
 * within seconds rather than at the cache's expiry.
 */

/** How far ahead "expiring" looks. */
export const GRANT_EXPIRING_WINDOW_DAYS = 14;

export interface ManualGrantView {
  id: string;
  schoolId: string;
  schoolName: string;
  kind: GrantKind;
  state: GrantState;
  capBytes: number | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  planCode: string | null;
  planName: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  amountMinor: number | null;
  currencyCode: string | null;
  minorUnit: number | null;
  hasReceipt: boolean;
  grantedByUserId: string;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}

interface GrantRow {
  id: string;
  school_id: string;
  school_name: string;
  kind: GrantKind;
  state: GrantState;
  cap_bytes: string | null;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  plan_code: string | null;
  plan_name: string | null;
  starts_at: Date;
  ends_at: Date;
  reason: string;
  amount_minor: string | null;
  currency_code: string | null;
  minor_unit: number | null;
  has_receipt: boolean;
  granted_by_user_id: string;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
}

function toView(row: GrantRow): ManualGrantView {
  return {
    id: row.id,
    schoolId: row.school_id,
    schoolName: row.school_name,
    kind: row.kind,
    state: row.state,
    capBytes: row.cap_bytes === null ? null : Number(row.cap_bytes),
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    planCode: row.plan_code,
    planName: row.plan_name,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    reason: row.reason,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    hasReceipt: row.has_receipt,
    grantedByUserId: row.granted_by_user_id,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokeReason: row.revoke_reason,
    createdAt: row.created_at.toISOString(),
  };
}

/** The armed school's grants matching a filter (and optionally one grant), newest end first. */
function grantRows(
  tx: TransactionSql,
  options: { filter?: GrantListFilter; kind?: GrantKind; grantId?: string },
) {
  const filter = options.filter ?? "all";
  const filterSql =
    filter === "active"
      ? tx`AND g.revoked_at IS NULL AND g.ends_at > now()`
      : filter === "expiring"
        ? tx`AND g.revoked_at IS NULL AND g.starts_at <= now() AND g.ends_at > now()
             AND g.ends_at <= now() + make_interval(days => ${GRANT_EXPIRING_WINDOW_DAYS})`
        : filter === "ended"
          ? tx`AND (g.revoked_at IS NOT NULL OR g.ends_at <= now())`
          : tx``;
  const kindSql = options.kind ? tx`AND g.kind = ${options.kind}` : tx``;
  const idSql = options.grantId ? tx`AND g.id = ${options.grantId}::uuid` : tx``;
  return tx<GrantRow[]>`
    SELECT g.id, g.school_id, s.name AS school_name, g.kind,
           CASE
             WHEN g.revoked_at IS NOT NULL THEN 'revoked'
             WHEN now() < g.starts_at THEN 'scheduled'
             WHEN now() >= g.ends_at THEN 'ended'
             ELSE 'active'
           END AS state,
           g.cap_bytes::text AS cap_bytes, g.user_id, u.display_name AS user_name,
           u.email AS user_email, p.code AS plan_code, p.display_name AS plan_name,
           g.starts_at, g.ends_at, g.reason, g.amount_minor::text AS amount_minor,
           cur.code AS currency_code, cur.minor_unit::int AS minor_unit,
           (g.receipt_storage_key IS NOT NULL) AS has_receipt, g.granted_by_user_id,
           g.revoked_at, g.revoke_reason, g.created_at
    FROM app.manual_grants g
    JOIN app.schools s ON s.id = g.school_id
    LEFT JOIN app.users u ON u.id = g.user_id AND u.school_id = g.school_id
    LEFT JOIN app.plans p ON p.id = g.plan_id
    LEFT JOIN app.currencies cur ON cur.id = g.currency_id
    WHERE g.school_id = current_setting('app.school_id')::uuid
      ${filterSql} ${kindSql} ${idSql}
    ORDER BY g.ends_at DESC, g.created_at DESC
  `;
}

/** One school's grants. Runs in a transaction already scoped to the school. */
export async function listSchoolGrants(
  tx: TransactionSql,
  filter: GrantListFilter,
  kind?: GrantKind,
): Promise<ManualGrantView[]> {
  return (await grantRows(tx, { filter, kind })).map(toView);
}

/**
 * Every school's grants matching a filter. "expiring" lists the soonest end first; everything else
 * the latest end first.
 */
export async function listAllGrants(
  database: Database | DatabasePools,
  filter: GrantListFilter,
  kind?: GrantKind,
): Promise<ManualGrantView[]> {
  return withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string }[]>`SELECT id FROM app.schools ORDER BY name, id`;
    const perSchool = await pipelinePerSchool(tx, schools, () => [grantRows(tx, { filter, kind })]);
    const grants = perSchool.flatMap(([rows]) => rows.map(toView));
    return grants.sort((a, b) =>
      filter === "expiring" ? a.endsAt.localeCompare(b.endsAt) : b.endsAt.localeCompare(a.endsAt),
    );
  });
}

async function requireGrant(
  tx: TransactionSql,
  grantId: string,
  actor: LicenseActor,
): Promise<ManualGrantView> {
  const [row] = await grantRows(tx, { grantId });
  if (!row) throw licenseError(404, ERROR_CODES.MANUAL_GRANT_NOT_FOUND, actor.locale);
  return toView(row);
}

export interface CreateGrantInput {
  kind: GrantKind;
  capBytes?: number;
  userId?: string;
  planCode?: string;
  startsAt?: Date;
  endsAt: Date;
  reason: string;
  amountMinor?: number;
  currencyCode?: string;
  /** Already promoted to permanent/ by the route. */
  receiptStorageKey: string | null;
}

/** A grant and the entitlement versions its change produced (tier grants only). */
export interface GrantChange {
  grant: ManualGrantView;
  versions: Map<string, number>;
}

function validationError(message: string): CodedHttpException {
  return new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

/**
 * Create a grant in the armed school. A tier must be an active tier of an audience the person
 * belongs to (the same eligibility a license seat uses), so a teacher cannot be handed a student
 * tier by mistake.
 */
export async function createGrant(
  tx: TransactionSql,
  schoolId: string,
  input: CreateGrantInput,
  actor: LicenseActor,
): Promise<GrantChange> {
  // No start means "from now" -- the transaction's own now(), so the grant is in force at once.
  const [clock] = await tx<{ now: Date }[]>`SELECT now() AS now`;
  const now = clock!.now;
  const startsAt = input.startsAt ?? now;
  if (input.endsAt.getTime() <= startsAt.getTime()) {
    throw validationError("The end must be after the start");
  }
  if (input.endsAt.getTime() <= now.getTime()) {
    throw validationError("The end must be in the future");
  }

  let currencyId: string | null = null;
  if (input.currencyCode !== undefined) {
    const [currency] = await tx<{ id: string }[]>`
      SELECT id FROM app.currencies WHERE code = ${input.currencyCode}
    `;
    if (!currency) throw validationError("Unknown currency");
    currencyId = currency.id;
  }

  let planId: string | null = null;
  if (input.kind === "tier") {
    const [plan] = await tx<{ id: string; eligible: boolean }[]>`
      SELECT p.id,
             app.license_seat_eligible(
               p.audience, ${input.userId!}::uuid, app.user_student_id(${input.userId!}::uuid)
             ) AS eligible
      FROM app.plans p
      WHERE p.code = ${input.planCode!} AND p.audience IS NOT NULL AND p.is_active
    `;
    if (!plan?.eligible) {
      throw licenseError(422, ERROR_CODES.MANUAL_GRANT_TIER_INVALID, actor.locale);
    }
    planId = plan.id;
  }

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.manual_grants (
      school_id, kind, cap_bytes, user_id, plan_id, starts_at, ends_at, reason,
      amount_minor, currency_id, receipt_storage_key, granted_by_user_id
    ) VALUES (
      ${schoolId}::uuid, ${input.kind},
      ${input.kind === "storage" ? input.capBytes! : null},
      ${input.kind === "tier" ? input.userId! : null}::uuid,
      ${planId}::uuid, ${startsAt}, ${input.endsAt}, ${input.reason},
      ${input.amountMinor ?? null}, ${currencyId}::uuid, ${input.receiptStorageKey},
      ${actor.userId}::uuid
    )
    RETURNING id
  `;

  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "manual_grants",
    targetId: inserted!.id,
    newValues: {
      kind: input.kind,
      cap_bytes: input.kind === "storage" ? input.capBytes : null,
      user_id: input.userId ?? null,
      plan_code: input.planCode ?? null,
      starts_at: startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
      reason: input.reason,
      amount_minor: input.amountMinor ?? null,
      currency_code: input.currencyCode ?? null,
      has_receipt: input.receiptStorageKey !== null,
    },
  });

  const versions =
    input.kind === "tier"
      ? await publishUserEntitlementChanges(tx, { schoolId, userIds: [input.userId!] })
      : new Map<string, number>();

  return { grant: await requireGrant(tx, inserted!.id, actor), versions };
}

/** Revoke a grant now, with a reason. The row stays; it just stops counting. */
export async function revokeGrant(
  tx: TransactionSql,
  schoolId: string,
  grantId: string,
  reason: string,
  actor: LicenseActor,
): Promise<GrantChange> {
  const [row] = await tx<
    { id: string; kind: GrantKind; user_id: string | null; revoked: boolean }[]
  >`
    SELECT id, kind, user_id, (revoked_at IS NOT NULL) AS revoked
    FROM app.manual_grants
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${grantId}::uuid
    FOR UPDATE
  `;
  if (!row) throw licenseError(404, ERROR_CODES.MANUAL_GRANT_NOT_FOUND, actor.locale);
  if (row.revoked) throw licenseError(409, ERROR_CODES.MANUAL_GRANT_ALREADY_REVOKED, actor.locale);

  await tx`
    UPDATE app.manual_grants
    SET revoked_at = now(), revoked_by_user_id = ${actor.userId}::uuid,
        revoke_reason = ${reason}, updated_at = now()
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${grantId}::uuid
  `;

  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "manual_grants",
    targetId: grantId,
    oldValues: { revoked_at: null },
    newValues: { revoked_at: new Date().toISOString(), revoke_reason: reason },
  });

  const versions =
    row.kind === "tier" && row.user_id
      ? await publishUserEntitlementChanges(tx, { schoolId, userIds: [row.user_id] })
      : new Map<string, number>();

  return { grant: await requireGrant(tx, grantId, actor), versions };
}

/** The grant's receipt key, or null when it has none. 404 when the grant does not exist. */
export async function grantReceiptKey(
  tx: TransactionSql,
  grantId: string,
  actor: LicenseActor,
): Promise<string | null> {
  const [row] = await tx<{ receipt_storage_key: string | null }[]>`
    SELECT receipt_storage_key FROM app.manual_grants
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${grantId}::uuid
  `;
  if (!row) throw licenseError(404, ERROR_CODES.MANUAL_GRANT_NOT_FOUND, actor.locale);
  return row.receipt_storage_key;
}
