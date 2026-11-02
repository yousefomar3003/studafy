import { LIVE_STATUSES } from "@studafy/billing";
import { ERROR_CODES, FEATURE_KEYS, FEATURES } from "@studafy/constants";

import { usagePeriodStart } from "../features/resolve";
import {
  invalidateEntitlementEntry,
  userEntitlementCacheKey,
} from "../subscriptions/entitlements/cache";
import { publishUserEntitlementChanges } from "../subscriptions/entitlements/entitlement-change-publisher";

import { auditLicenseChange, inSchool, licenseError, rethrowLicenseDbError } from "./context";
import { applyRenewalStops, recordSeatOverlaps } from "./overlap";

import type { LicenseActor } from "./context";
import type {
  CoveringSeat,
  PendingRenewalStop,
  RenewalProviders,
  RenewalStopOutcome,
} from "./overlap";
import type { Database, DatabasePools } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { Logger } from "../../logger";
import type { RedisClient } from "../../redis";
import type { FeatureKey, FeatureUsageUnit } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * School feature licenses and their seats (session 2 of docs/billing/feature-licensing.md).
 *
 * The rules that must hold under concurrency -- the seat cap, eligibility, tiers of the right
 * audience, one active license per school -- are the database's (migration 000163); this service
 * picks the people, keeps the audit trail, and tells the entitlement cache. Every function that
 * changes who is covered publishes a `user` entitlement change for each person affected, in the same
 * transaction, and the flows below also invalidate those cache entries directly once it commits.
 *
 * Functions taking a `tx` run inside a transaction already scoped to the school (see ./context.ts);
 * the `*Flow` functions open it, and run what must happen after commit (provider calls, cache).
 */

export const AUDIENCES = ["student", "teacher", "parent"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const LICENSE_STATUSES = [
  "draft",
  "awaiting_payment",
  "active",
  "expired",
  "cancelled",
  "suspended",
] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/**
 * Status changes the super admin can make. `expired` is not here: it is the end date passing (the
 * resolver stops covering at `ends_at` by itself; session 3's job records the status).
 */
export const LICENSE_TRANSITIONS: Readonly<Record<LicenseStatus, readonly LicenseStatus[]>> = {
  draft: ["awaiting_payment", "active", "cancelled"],
  awaiting_payment: ["draft", "active", "cancelled"],
  active: ["suspended", "cancelled"],
  suspended: ["active", "cancelled"],
  expired: [],
  cancelled: [],
};

/** Statuses whose seats cover people (subject to the dates). Changes here move entitlements. */
const COVERING_STATUSES: ReadonlySet<LicenseStatus> = new Set(["active"]);
/** Statuses that take new seats. Mirrors ck_license_seats_license_open in the seat trigger. */
const ASSIGNABLE_STATUSES: ReadonlySet<LicenseStatus> = new Set([
  "draft",
  "awaiting_payment",
  "active",
]);

/** The most people one assignment request may name. */
export const MAX_ASSIGN_USER_IDS = 500;

export interface LicenseRecord {
  id: string;
  schoolId: string;
  status: LicenseStatus;
  startsAt: Date;
  endsAt: Date;
  studentPlanId: string | null;
  studentSeats: number;
  teacherPlanId: string | null;
  teacherSeats: number;
  includeFamilyPlus: boolean;
  parentPlanId: string | null;
  parentSeats: number;
  currencyId: string;
  currencyCode: string;
  notes: string | null;
  createdBy: string;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LicenseRow {
  id: string;
  school_id: string;
  status: LicenseStatus;
  starts_at: Date;
  ends_at: Date;
  student_plan_id: string | null;
  student_seats: number;
  teacher_plan_id: string | null;
  teacher_seats: number;
  include_family_plus: boolean;
  parent_plan_id: string | null;
  parent_seats: number;
  currency_id: string;
  currency_code: string;
  notes: string | null;
  created_by: string;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: LicenseRow): LicenseRecord {
  return {
    id: row.id,
    schoolId: row.school_id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    studentPlanId: row.student_plan_id,
    studentSeats: row.student_seats,
    teacherPlanId: row.teacher_plan_id,
    teacherSeats: row.teacher_seats,
    includeFamilyPlus: row.include_family_plus,
    parentPlanId: row.parent_plan_id,
    parentSeats: row.parent_seats,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    notes: row.notes,
    createdBy: row.created_by,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Purchased seats of one audience: parents only when the license includes Family+. */
export function purchasedSeats(license: LicenseRecord, audience: Audience): number {
  if (audience === "student") return license.studentSeats;
  if (audience === "teacher") return license.teacherSeats;
  return license.includeFamilyPlus ? license.parentSeats : 0;
}

function planIdFor(license: LicenseRecord, audience: Audience): string | null {
  if (audience === "student") return license.studentPlanId;
  if (audience === "teacher") return license.teacherPlanId;
  return license.parentPlanId;
}

const LICENSE_COLUMNS = (tx: TransactionSql) => tx`
  l.id::text AS id, l.school_id::text AS school_id, l.status, l.starts_at, l.ends_at,
  l.student_plan_id::text AS student_plan_id, l.student_seats,
  l.teacher_plan_id::text AS teacher_plan_id, l.teacher_seats,
  l.include_family_plus, l.parent_plan_id::text AS parent_plan_id, l.parent_seats,
  l.currency_id::text AS currency_id, c.code AS currency_code, l.notes, l.created_by::text AS created_by,
  l.activated_at, l.created_at, l.updated_at
`;

export async function readLicense(
  tx: TransactionSql,
  licenseId: string,
  options: { forUpdate?: boolean } = {},
): Promise<LicenseRecord | null> {
  const [row] = await tx<LicenseRow[]>`
    SELECT ${LICENSE_COLUMNS(tx)}
    FROM app.school_licenses AS l
    JOIN app.currencies AS c ON c.id = l.currency_id
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.id = ${licenseId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE OF l` : tx``}
  `;
  return row ? toRecord(row) : null;
}

async function requireLicense(
  tx: TransactionSql,
  licenseId: string,
  actor: LicenseActor,
  options: { forUpdate?: boolean } = {},
): Promise<LicenseRecord> {
  const license = await readLicense(tx, licenseId, options);
  if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
  return license;
}

/**
 * The license a school sees and assigns seats on: the active one; else one awaiting payment (seats
 * can be prepared before activation); else the most recent suspended, expired or cancelled one, for
 * display. Drafts are the super admin's and never shown to the school.
 */
export async function currentLicense(
  tx: TransactionSql,
  options: { forUpdate?: boolean } = {},
): Promise<LicenseRecord | null> {
  const [row] = await tx<LicenseRow[]>`
    SELECT ${LICENSE_COLUMNS(tx)}
    FROM app.school_licenses AS l
    JOIN app.currencies AS c ON c.id = l.currency_id
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.status <> 'draft'
    ORDER BY CASE l.status
               WHEN 'active' THEN 0
               WHEN 'awaiting_payment' THEN 1
               WHEN 'suspended' THEN 2
               ELSE 3
             END,
             l.starts_at DESC,
             l.created_at DESC
    LIMIT 1
    ${options.forUpdate ? tx`FOR UPDATE OF l` : tx``}
  `;
  return row ? toRecord(row) : null;
}

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

export interface TierRef {
  id: string;
  code: string;
  displayName: string;
}

export interface AudienceSeats {
  audience: Audience;
  tier: TierRef | null;
  purchased: number;
  assigned: number;
}

export interface LicenseView {
  id: string;
  status: LicenseStatus;
  startsAt: string;
  endsAt: string;
  includeFamilyPlus: boolean;
  currencyCode: string;
  activatedAt: string | null;
  audiences: AudienceSeats[];
}

export interface PlatformLicenseView extends LicenseView {
  schoolId: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  allowedTransitions: LicenseStatus[];
}

async function audienceSeats(tx: TransactionSql, license: LicenseRecord): Promise<AudienceSeats[]> {
  const planIds = AUDIENCES.map((a) => planIdFor(license, a)).filter((id): id is string =>
    Boolean(id),
  );
  const [tiers, counts] = await Promise.all([
    planIds.length === 0
      ? Promise.resolve([] as { id: string; code: string; display_name: string }[])
      : tx<{ id: string; code: string; display_name: string }[]>`
          SELECT id::text AS id, code, display_name FROM app.plans WHERE id = ANY(${planIds}::uuid[])
        `,
    tx<{ audience: Audience; assigned: string }[]>`
      SELECT audience, count(*)::text AS assigned
      FROM app.license_seats
      WHERE school_id = current_setting('app.school_id')::uuid
        AND license_id = ${license.id}::uuid
        AND unassigned_at IS NULL
      GROUP BY audience
    `,
  ]);

  return AUDIENCES.map((audience) => {
    const tier = tiers.find((t) => t.id === planIdFor(license, audience));
    return {
      audience,
      tier: tier ? { id: tier.id, code: tier.code, displayName: tier.display_name } : null,
      purchased: purchasedSeats(license, audience),
      assigned: Number(counts.find((c) => c.audience === audience)?.assigned ?? 0),
    };
  });
}

export async function licenseView(
  tx: TransactionSql,
  license: LicenseRecord,
): Promise<LicenseView> {
  return {
    id: license.id,
    status: license.status,
    startsAt: license.startsAt.toISOString(),
    endsAt: license.endsAt.toISOString(),
    includeFamilyPlus: license.includeFamilyPlus,
    currencyCode: license.currencyCode,
    activatedAt: license.activatedAt?.toISOString() ?? null,
    audiences: await audienceSeats(tx, license),
  };
}

export async function platformLicenseView(
  tx: TransactionSql,
  license: LicenseRecord,
): Promise<PlatformLicenseView> {
  return {
    ...(await licenseView(tx, license)),
    schoolId: license.schoolId,
    notes: license.notes,
    createdBy: license.createdBy,
    createdAt: license.createdAt.toISOString(),
    updatedAt: license.updatedAt.toISOString(),
    allowedTransitions: [...LICENSE_TRANSITIONS[license.status]],
  };
}

export async function listLicenses(tx: TransactionSql): Promise<PlatformLicenseView[]> {
  const rows = await tx<LicenseRow[]>`
    SELECT ${LICENSE_COLUMNS(tx)}
    FROM app.school_licenses AS l
    JOIN app.currencies AS c ON c.id = l.currency_id
    WHERE l.school_id = current_setting('app.school_id')::uuid
    ORDER BY l.created_at DESC
  `;
  const views: PlatformLicenseView[] = [];
  for (const row of rows) views.push(await platformLicenseView(tx, toRecord(row)));
  return views;
}

// ---------------------------------------------------------------------------------------------------
// Entitlement propagation
// ---------------------------------------------------------------------------------------------------

/** Everyone holding a seat on the license now. */
async function seatHolders(tx: TransactionSql, licenseId: string): Promise<string[]> {
  const rows = await tx<{ user_id: string }[]>`
    SELECT DISTINCT user_id::text AS user_id
    FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${licenseId}::uuid
      AND unassigned_at IS NULL
  `;
  return rows.map((row) => row.user_id);
}

/** What a flow hands back for after-commit work. */
export interface Changed<T> {
  result: T;
  versions: Map<string, number>;
  pending: PendingRenewalStop[];
}

// ---------------------------------------------------------------------------------------------------
// License lifecycle (super admin)
// ---------------------------------------------------------------------------------------------------

export interface AudienceInput {
  planId: string | null;
  seats: number;
}

export interface CreateLicenseInput {
  startsAt: Date;
  endsAt: Date;
  currencyCode: string;
  includeFamilyPlus: boolean;
  student?: AudienceInput;
  teacher?: AudienceInput;
  parent?: AudienceInput;
  notes?: string | null;
}

async function currencyIdFor(
  tx: TransactionSql,
  code: string,
  actor: LicenseActor,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.currencies WHERE code = ${code} AND is_active
  `;
  if (!row) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  return row.id;
}

function licenseSnapshot(license: LicenseRecord): Record<string, unknown> {
  return {
    status: license.status,
    starts_at: license.startsAt.toISOString(),
    ends_at: license.endsAt.toISOString(),
    student_plan_id: license.studentPlanId,
    student_seats: license.studentSeats,
    teacher_plan_id: license.teacherPlanId,
    teacher_seats: license.teacherSeats,
    include_family_plus: license.includeFamilyPlus,
    parent_plan_id: license.parentPlanId,
    parent_seats: license.parentSeats,
    currency_code: license.currencyCode,
    notes: license.notes,
  };
}

/** Only the keys whose values differ, for an update's audit row. */
function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      oldValues[key] = before[key];
      newValues[key] = after[key];
    }
  }
  return { oldValues, newValues };
}

export async function createLicense(
  tx: TransactionSql,
  schoolId: string,
  input: CreateLicenseInput,
  actor: LicenseActor,
): Promise<LicenseRecord> {
  const currencyId = await currencyIdFor(tx, input.currencyCode, actor);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.school_licenses (
      school_id, status, starts_at, ends_at, student_plan_id, student_seats, teacher_plan_id,
      teacher_seats, include_family_plus, parent_plan_id, parent_seats, currency_id, notes, created_by
    ) VALUES (
      ${schoolId}::uuid, 'draft', ${input.startsAt}, ${input.endsAt},
      ${input.student?.planId ?? null}::uuid, ${input.student?.seats ?? 0},
      ${input.teacher?.planId ?? null}::uuid, ${input.teacher?.seats ?? 0},
      ${input.includeFamilyPlus},
      ${input.parent?.planId ?? null}::uuid, ${input.parent?.seats ?? 0},
      ${currencyId}::uuid, ${input.notes ?? null}, ${actor.userId}::uuid
    )
    RETURNING id::text AS id
  `;
  const license = (await readLicense(tx, row!.id))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "school_licenses",
    targetId: license.id,
    newValues: licenseSnapshot(license),
  });
  return license;
}

export interface UpdateLicenseInput {
  startsAt?: Date;
  endsAt?: Date;
  currencyCode?: string;
  includeFamilyPlus?: boolean;
  student?: Partial<AudienceInput>;
  teacher?: Partial<AudienceInput>;
  parent?: Partial<AudienceInput>;
  notes?: string | null;
}

/**
 * Edit a license. Before it is sent for payment everything is editable; once active or suspended,
 * the tiers, seat counts, Family+ and notes are (the dates move through extendLicense, the currency
 * not at all); an expired or cancelled license is history.
 */
export async function updateLicense(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  input: UpdateLicenseInput,
  actor: LicenseActor,
): Promise<Changed<LicenseRecord>> {
  const before = await requireLicense(tx, licenseId, actor, { forUpdate: true });
  const unsent = before.status === "draft" || before.status === "awaiting_payment";
  const running = before.status === "active" || before.status === "suspended";
  const touchesTerms =
    input.startsAt !== undefined || input.endsAt !== undefined || input.currencyCode !== undefined;
  if (!(unsent || running) || (running && touchesTerms)) {
    throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
  }

  const currencyId = input.currencyCode
    ? await currencyIdFor(tx, input.currencyCode, actor)
    : before.currencyId;
  const pick = (
    patch: Partial<AudienceInput> | undefined,
    planId: string | null,
    seats: number,
  ) => ({
    planId: patch?.planId !== undefined ? patch.planId : planId,
    seats: patch?.seats ?? seats,
  });
  const student = pick(input.student, before.studentPlanId, before.studentSeats);
  const teacher = pick(input.teacher, before.teacherPlanId, before.teacherSeats);
  const parent = pick(input.parent, before.parentPlanId, before.parentSeats);

  await tx`
    UPDATE app.school_licenses SET
      starts_at = ${input.startsAt ?? before.startsAt},
      ends_at = ${input.endsAt ?? before.endsAt},
      currency_id = ${currencyId}::uuid,
      include_family_plus = ${input.includeFamilyPlus ?? before.includeFamilyPlus},
      student_plan_id = ${student.planId}::uuid, student_seats = ${student.seats},
      teacher_plan_id = ${teacher.planId}::uuid, teacher_seats = ${teacher.seats},
      parent_plan_id = ${parent.planId}::uuid, parent_seats = ${parent.seats},
      notes = ${input.notes !== undefined ? input.notes : before.notes},
      updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE id = ${licenseId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  const after = (await readLicense(tx, licenseId))!;
  const changes = diff(licenseSnapshot(before), licenseSnapshot(after));
  if (Object.keys(changes.newValues).length > 0) {
    await auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "school_licenses",
      targetId: licenseId,
      ...changes,
    });
  }

  // A tier or Family+ change on a license in force changes what its seat holders get.
  const versions = COVERING_STATUSES.has(after.status)
    ? await publishUserEntitlementChanges(tx, {
        schoolId,
        userIds: await seatHolders(tx, licenseId),
      })
    : new Map<string, number>();
  return { result: after, versions, pending: [] };
}

/**
 * Move a license through its lifecycle. Activating (or resuming) it starts covering every seat
 * holder, so their overlaps with personal subscriptions are recorded then; any change of a license
 * in force, or into force, moves its holders' entitlements.
 */
export async function transitionLicense(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  to: LicenseStatus,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<LicenseRecord>> {
  const before = await requireLicense(tx, licenseId, actor, { forUpdate: true });
  if (!LICENSE_TRANSITIONS[before.status].includes(to)) {
    throw licenseError(409, ERROR_CODES.LICENSE_INVALID_TRANSITION, actor.locale);
  }

  await tx`
    UPDATE app.school_licenses SET
      status = ${to},
      activated_at = ${to === "active" ? tx`COALESCE(activated_at, CURRENT_TIMESTAMP)` : tx`activated_at`},
      updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE id = ${licenseId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  const after = (await readLicense(tx, licenseId))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "school_licenses",
    targetId: licenseId,
    oldValues: { status: before.status },
    newValues: { status: to },
  });

  let versions = new Map<string, number>();
  let pending: PendingRenewalStop[] = [];
  if (COVERING_STATUSES.has(before.status) || COVERING_STATUSES.has(to)) {
    versions = await publishUserEntitlementChanges(tx, {
      schoolId,
      userIds: await seatHolders(tx, licenseId),
    });
  }
  if (to === "active") {
    pending = await recordSeatOverlaps(tx, {
      schoolId,
      license: after,
      seats: await coveringSeats(tx, licenseId),
      actor,
      now,
    });
  }
  return { result: after, versions, pending };
}

/** Move the end date later. A shorter license is a cancellation, not an extension. */
export async function extendLicense(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  endsAt: Date,
  actor: LicenseActor,
): Promise<Changed<LicenseRecord>> {
  const before = await requireLicense(tx, licenseId, actor, { forUpdate: true });
  if (before.status === "expired" || before.status === "cancelled") {
    throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
  }
  if (endsAt.getTime() <= before.endsAt.getTime()) {
    throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  }

  await tx`
    UPDATE app.school_licenses
    SET ends_at = ${endsAt}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE id = ${licenseId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  const after = (await readLicense(tx, licenseId))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "school_licenses",
    targetId: licenseId,
    oldValues: { ends_at: before.endsAt.toISOString() },
    newValues: { ends_at: after.endsAt.toISOString() },
  });

  const versions = COVERING_STATUSES.has(after.status)
    ? await publishUserEntitlementChanges(tx, {
        schoolId,
        userIds: await seatHolders(tx, licenseId),
      })
    : new Map<string, number>();
  return { result: after, versions, pending: [] };
}

// ---------------------------------------------------------------------------------------------------
// People: who can hold a seat, by scope
// ---------------------------------------------------------------------------------------------------

/** Whom a bulk assignment or an eligibility list targets. */
export type SeatScope =
  | { kind: "all" }
  | { kind: "grade"; gradeLevelId: string }
  | { kind: "section"; sectionId: string }
  | { kind: "class"; classId: string };

interface CandidateRow {
  user_id: string;
  student_id: string | null;
  name: string;
  email: string;
  eligible: boolean;
  seated: boolean;
  personal: boolean;
  /** The person's active seat of the audience on this license, if any. */
  seat_id: string | null;
  assigned_at: Date | null;
  /** When their latest live personal subscription of the audience ends, if they have one. */
  personal_ends_at: Date | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Students in scope, as a subquery of student ids (null for every student). */
function studentIdsInScope(tx: TransactionSql, scope: SeatScope) {
  switch (scope.kind) {
    case "all":
      return null;
    case "grade":
      return tx`
        SELECT ss.student_id
        FROM app.student_sections AS ss
        JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
        JOIN app.academic_years AS ay ON ay.id = ss.academic_year_id AND ay.school_id = ss.school_id
        WHERE ss.school_id = current_setting('app.school_id')::uuid
          AND sec.grade_level_id = ${scope.gradeLevelId}::uuid
          AND ay.status = 'active'
      `;
    case "section":
      return tx`
        SELECT ss.student_id
        FROM app.student_sections AS ss
        WHERE ss.school_id = current_setting('app.school_id')::uuid
          AND ss.section_id = ${scope.sectionId}::uuid
      `;
    case "class":
      return tx`
        SELECT e.student_id
        FROM app.enrollments AS e
        WHERE e.school_id = current_setting('app.school_id')::uuid
          AND e.class_id = ${scope.classId}::uuid
          AND e.status = 'active'
      `;
  }
}

/** Classes in scope, for teachers: the classes whose teachers are targeted (null for every teacher). */
function classIdsInScope(tx: TransactionSql, scope: SeatScope) {
  switch (scope.kind) {
    case "all":
      return null;
    case "grade":
      return tx`
        SELECT c.id
        FROM app.classes AS c
        JOIN app.sections AS sec ON sec.id = c.section_id AND sec.school_id = c.school_id
        JOIN app.academic_years AS ay ON ay.id = sec.academic_year_id AND ay.school_id = sec.school_id
        WHERE c.school_id = current_setting('app.school_id')::uuid
          AND sec.grade_level_id = ${scope.gradeLevelId}::uuid
          AND ay.status = 'active'
      `;
    case "section":
      return tx`
        SELECT c.id FROM app.classes AS c
        WHERE c.school_id = current_setting('app.school_id')::uuid
          AND c.section_id = ${scope.sectionId}::uuid
      `;
    case "class":
      return tx`SELECT ${scope.classId}::uuid AS id`;
  }
}

/**
 * The people of one audience in scope (or named by id), with whether each may hold a seat
 * (app.license_seat_eligible, the trigger's own rule), already holds one on this license, and has a
 * personal subscription of that audience. Ordered by name, which is the order a bulk assignment
 * fills seats in.
 */
async function candidates(
  tx: TransactionSql,
  input: {
    licenseId: string;
    audience: Audience;
    scope?: SeatScope;
    userIds?: readonly string[];
    search?: string;
    onlyAssignable?: boolean;
    /** Only people holding a seat ("seated") or not ("unseated"). */
    seat?: "seated" | "unseated";
    /** Only people with a live personal subscription of the audience. */
    onlyPersonal?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<{ rows: CandidateRow[]; total: number }> {
  const { licenseId, audience, scope = { kind: "all" } } = input;
  const live = [...LIVE_STATUSES];
  const byIds = input.userIds ? tx`AND p.user_id = ANY(${[...input.userIds]}::uuid[])` : tx``;
  const search = input.search?.trim()
    ? tx`AND (p.name ILIKE ${`%${escapeLike(input.search.trim())}%`}
              OR p.email ILIKE ${`%${escapeLike(input.search.trim())}%`})`
    : tx``;

  let people;
  if (audience === "student") {
    const inScope = studentIdsInScope(tx, scope);
    people = tx`
      SELECT s.user_id, s.id AS student_id,
             COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.last_name)), ''), u.display_name, u.email) AS name,
             u.email
      FROM app.students AS s
      JOIN app.users AS u ON u.id = s.user_id AND u.school_id = s.school_id
      WHERE s.school_id = current_setting('app.school_id')::uuid
        ${inScope ? tx`AND s.id IN (${inScope})` : tx``}
    `;
  } else if (audience === "teacher") {
    const inScope = classIdsInScope(tx, scope);
    people = tx`
      SELECT t.user_id, NULL::uuid AS student_id, COALESCE(u.display_name, u.email) AS name, u.email
      FROM app.teachers AS t
      JOIN app.users AS u ON u.id = t.user_id AND u.school_id = t.school_id
      WHERE t.school_id = current_setting('app.school_id')::uuid
        ${
          inScope
            ? tx`AND t.id IN (
                SELECT c.lead_teacher_id FROM app.classes AS c
                WHERE c.school_id = current_setting('app.school_id')::uuid AND c.id IN (${inScope})
                UNION
                SELECT ts.teacher_id FROM app.timetable_slots AS ts
                WHERE ts.school_id = current_setting('app.school_id')::uuid AND ts.class_id IN (${inScope})
              )`
            : tx``
        }
    `;
  } else {
    const inScope = studentIdsInScope(tx, scope);
    people = tx`
      SELECT DISTINCT u.id AS user_id, NULL::uuid AS student_id,
             COALESCE(u.display_name, u.email) AS name, u.email
      FROM app.parent_child_links AS pcl
      JOIN app.users AS u ON u.id = pcl.parent_user_id AND u.school_id = pcl.school_id
      WHERE pcl.school_id = current_setting('app.school_id')::uuid
        ${inScope ? tx`AND pcl.student_id IN (${inScope})` : tx``}
    `;
  }

  const rows = await tx<(CandidateRow & { total: string })[]>`
    WITH p AS (${people}),
    found AS (
      SELECT
        p.user_id::text AS user_id,
        p.student_id::text AS student_id,
        p.name,
        p.email,
        app.license_seat_eligible(${audience}, p.user_id, p.student_id) AS eligible,
        seat.id::text AS seat_id,
        seat.assigned_at,
        -- GREATEST skips NULLs: the later of the two kinds of personal subscription.
        GREATEST(
          (
            SELECT max(us.current_period_end) FROM app.user_subscriptions AS us
            JOIN app.plans AS pl ON pl.id = us.plan_id
            WHERE us.school_id = current_setting('app.school_id')::uuid
              AND us.user_id = p.user_id
              AND pl.audience = ${audience}
              AND us.status::text = ANY(${live})
              AND us.current_period_end > CURRENT_TIMESTAMP
          ),
          CASE WHEN p.student_id IS NOT NULL THEN (
            SELECT max(ai.current_period_end) FROM app.ai_subscriptions AS ai
            WHERE ai.school_id = current_setting('app.school_id')::uuid
              AND ai.student_id = p.student_id
              AND ai.status::text = ANY(${live})
              AND ai.current_period_end > CURRENT_TIMESTAMP
          ) END
        ) AS personal_ends_at
      FROM p
      LEFT JOIN LATERAL (
        SELECT ls.id, ls.assigned_at FROM app.license_seats AS ls
        WHERE ls.school_id = current_setting('app.school_id')::uuid
          AND ls.license_id = ${licenseId}::uuid
          AND ls.audience = ${audience}
          AND ls.user_id = p.user_id
          AND ls.unassigned_at IS NULL
      ) AS seat ON true
      WHERE true ${byIds} ${search}
    ),
    marked AS (
      SELECT *, seat_id IS NOT NULL AS seated, personal_ends_at IS NOT NULL AS personal FROM found
    )
    SELECT *, count(*) OVER ()::text AS total
    FROM marked
    WHERE true
      ${input.onlyAssignable ? tx`AND eligible AND NOT seated` : tx``}
      ${input.seat === "seated" ? tx`AND seated` : input.seat === "unseated" ? tx`AND NOT seated` : tx``}
      ${input.onlyPersonal ? tx`AND personal` : tx``}
    ORDER BY lower(name), email, user_id
    ${input.limit !== undefined ? tx`LIMIT ${input.limit} OFFSET ${input.offset ?? 0}` : tx``}
  `;

  return { rows, total: Number(rows[0]?.total ?? 0) };
}

export interface EligiblePerson {
  userId: string;
  studentId: string | null;
  name: string;
  email: string;
  hasPersonalSubscription: boolean;
}

/** People of an audience who could get a seat and do not have one yet. */
export async function listEligible(
  tx: TransactionSql,
  license: LicenseRecord,
  input: { audience: Audience; scope?: SeatScope; search?: string; limit: number; offset: number },
): Promise<{ people: EligiblePerson[]; total: number }> {
  const { rows, total } = await candidates(tx, {
    licenseId: license.id,
    audience: input.audience,
    scope: input.scope,
    search: input.search,
    onlyAssignable: true,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    people: rows.map((row) => ({
      userId: row.user_id,
      studentId: row.student_id,
      name: row.name,
      email: row.email,
      hasPersonalSubscription: row.personal,
    })),
    total,
  };
}

export interface LicensePerson extends EligiblePerson {
  /** Whether they may hold a seat of the audience (enrolled, active, linked...). */
  eligible: boolean;
  /** Their seat on this license, if they hold one. */
  seatId: string | null;
  assignedAt: string | null;
  /** When their personal subscription ends, if they have a live one. */
  personalSubscriptionEndsAt: string | null;
}

/**
 * Everyone of an audience in scope with their seat status on the license: who holds a seat, who
 * could get one, who cannot, and who pays personally (with when that ends) -- the school's seat
 * screen.
 */
export async function listPeople(
  tx: TransactionSql,
  license: LicenseRecord,
  input: {
    audience: Audience;
    scope?: SeatScope;
    search?: string;
    seat?: "seated" | "unseated";
    onlyPersonal?: boolean;
    limit: number;
    offset: number;
  },
): Promise<{ people: LicensePerson[]; total: number }> {
  const { rows, total } = await candidates(tx, { licenseId: license.id, ...input });
  return {
    people: rows.map((row) => ({
      userId: row.user_id,
      studentId: row.student_id,
      name: row.name,
      email: row.email,
      eligible: row.eligible,
      seatId: row.seat_id,
      assignedAt: row.assigned_at?.toISOString() ?? null,
      hasPersonalSubscription: row.personal,
      personalSubscriptionEndsAt: row.personal_ends_at?.toISOString() ?? null,
    })),
    total,
  };
}

// ---------------------------------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------------------------------

export type AssignRequest =
  { audience: Audience; userIds: readonly string[] } | { audience: Audience; scope: SeatScope };

export type NotAssignedReason = "already_assigned" | "not_eligible" | "no_seats_left";

export interface AssignResult {
  assigned: { seatId: string; userId: string; name: string }[];
  notAssigned: { userId: string; name: string | null; reason: NotAssignedReason }[];
}

async function coveringSeats(tx: TransactionSql, licenseId: string): Promise<CoveringSeat[]> {
  const rows = await tx<
    { seat_id: string; user_id: string; student_id: string | null; audience: Audience }[]
  >`
    SELECT id::text AS seat_id, user_id::text AS user_id, student_id::text AS student_id, audience
    FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${licenseId}::uuid
      AND unassigned_at IS NULL
  `;
  return rows.map((row) => ({
    seatId: row.seat_id,
    userId: row.user_id,
    studentId: row.student_id,
    audience: row.audience,
  }));
}

/**
 * Assign seats individually or in bulk, until the purchased seats run out.
 *
 * The license row is locked first, so the free-seat count below is exact for this transaction
 * (the seat trigger takes the same lock, so a concurrent assignment waits). People already seated or
 * not eligible are reported, not failed; when seats run out, the rest -- in name order -- are
 * reported as `no_seats_left`. A seat on an active license covers its holder at once, so overlaps
 * with personal subscriptions are recorded here too.
 */
export async function assignSeats(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  request: AssignRequest,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<AssignResult>> {
  const license = await requireLicense(tx, licenseId, actor, { forUpdate: true });
  if (!ASSIGNABLE_STATUSES.has(license.status)) {
    throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
  }
  const purchased = purchasedSeats(license, request.audience);
  if (purchased === 0) {
    throw licenseError(409, ERROR_CODES.LICENSE_AUDIENCE_NOT_LICENSED, actor.locale);
  }

  const explicit = "userIds" in request;
  const { rows } = await candidates(tx, {
    licenseId,
    audience: request.audience,
    ...(explicit ? { userIds: request.userIds } : { scope: request.scope }),
  });

  const result: AssignResult = { assigned: [], notAssigned: [] };
  if (explicit) {
    // Named people who are not in the school's audience at all never came back from the query.
    const found = new Set(rows.map((row) => row.user_id));
    for (const userId of new Set(request.userIds)) {
      if (!found.has(userId))
        result.notAssigned.push({ userId, name: null, reason: "not_eligible" });
    }
  }

  const [counted] = await tx<{ assigned: string }[]>`
    SELECT count(*)::text AS assigned
    FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${licenseId}::uuid
      AND audience = ${request.audience}
      AND unassigned_at IS NULL
  `;
  let free = purchased - Number(counted?.assigned ?? 0);

  const toAssign: CandidateRow[] = [];
  for (const row of rows) {
    if (row.seated) {
      result.notAssigned.push({ userId: row.user_id, name: row.name, reason: "already_assigned" });
    } else if (!row.eligible) {
      // A bulk scope only reports people who could have had a seat; a named person is reported.
      if (explicit)
        result.notAssigned.push({ userId: row.user_id, name: row.name, reason: "not_eligible" });
    } else if (free > 0) {
      toAssign.push(row);
      free -= 1;
    } else {
      result.notAssigned.push({ userId: row.user_id, name: row.name, reason: "no_seats_left" });
    }
  }

  if (toAssign.length === 0) return { result, versions: new Map(), pending: [] };

  // One statement; the seat trigger still checks every row (capacity and eligibility).
  const inserted = await tx<{ id: string; user_id: string }[]>`
    INSERT INTO app.license_seats (
      school_id, license_id, audience, user_id, student_id, assigned_by, assigned_by_platform
    )
    SELECT ${schoolId}::uuid, ${licenseId}::uuid, ${request.audience}, p.user_id, p.student_id,
           ${actor.userId}::uuid, ${actor.kind === "platform"}
    FROM unnest(
      ${toAssign.map((row) => row.user_id)}::uuid[],
      ${toAssign.map((row) => row.student_id)}::uuid[]
    ) AS p (user_id, student_id)
    RETURNING id::text AS id, user_id::text AS user_id
  `;

  const names = new Map(toAssign.map((row) => [row.user_id, row]));
  const covering: CoveringSeat[] = [];
  for (const seat of inserted) {
    const person = names.get(seat.user_id)!;
    result.assigned.push({ seatId: seat.id, userId: seat.user_id, name: person.name });
    covering.push({
      seatId: seat.id,
      userId: seat.user_id,
      studentId: person.student_id,
      audience: request.audience,
    });
    await auditLicenseChange(tx, schoolId, actor, {
      action: "insert",
      targetTable: "license_seats",
      targetId: seat.id,
      newValues: {
        license_id: licenseId,
        audience: request.audience,
        user_id: seat.user_id,
        student_id: person.student_id,
        assigned_by_platform: actor.kind === "platform",
      },
    });
  }

  const versions = await publishUserEntitlementChanges(tx, {
    schoolId,
    userIds: inserted.map((seat) => seat.user_id),
  });
  const pending = COVERING_STATUSES.has(license.status)
    ? await recordSeatOverlaps(tx, { schoolId, license, seats: covering, actor, now })
    : [];
  return { result, versions, pending };
}

/** Free a seat. The holder's personal subscription, if any, is left exactly as it is. */
export async function unassignSeat(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  seatId: string,
  actor: LicenseActor,
): Promise<Changed<{ seatId: string; userId: string }>> {
  const [seat] = await tx<{ user_id: string; unassigned_at: Date | null }[]>`
    SELECT user_id::text AS user_id, unassigned_at
    FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${licenseId}::uuid
      AND id = ${seatId}::uuid
    FOR UPDATE
  `;
  if (!seat || seat.unassigned_at) {
    throw licenseError(404, ERROR_CODES.LICENSE_SEAT_NOT_FOUND, actor.locale);
  }

  const [updated] = await tx<{ unassigned_at: Date }[]>`
    UPDATE app.license_seats
    SET unassigned_at = CURRENT_TIMESTAMP,
        unassigned_by = ${actor.userId}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE id = ${seatId}::uuid AND school_id = current_setting('app.school_id')::uuid
    RETURNING unassigned_at
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_seats",
    targetId: seatId,
    oldValues: { unassigned_at: null },
    newValues: { unassigned_at: updated!.unassigned_at.toISOString(), unassigned_by: actor.userId },
  });

  const versions = await publishUserEntitlementChanges(tx, { schoolId, userIds: [seat.user_id] });
  return { result: { seatId, userId: seat.user_id }, versions, pending: [] };
}

export interface SeatView {
  seatId: string;
  audience: Audience;
  userId: string;
  studentId: string | null;
  name: string;
  email: string;
  assignedAt: string;
  assignedByPlatform: boolean;
  unassignedAt: string | null;
  /** The latest overlap with a personal subscription, if the seat holder pays personally. */
  overlap: {
    provider: string | null;
    overlapDays: number;
    creditMinor: number | null;
    renewalAction: string;
    renewalStatus: string;
  } | null;
}

export async function listSeats(
  tx: TransactionSql,
  licenseId: string,
  input: {
    audience?: Audience;
    status: "active" | "unassigned" | "all";
    search?: string;
    limit: number;
    offset: number;
  },
): Promise<{ seats: SeatView[]; total: number }> {
  const pattern = input.search?.trim() ? `%${escapeLike(input.search.trim())}%` : null;
  const rows = await tx<
    {
      seat_id: string;
      audience: Audience;
      user_id: string;
      student_id: string | null;
      name: string;
      email: string;
      assigned_at: Date;
      assigned_by_platform: boolean;
      unassigned_at: Date | null;
      provider: string | null;
      overlap_days: number | null;
      credit_minor: string | null;
      renewal_action: string | null;
      renewal_status: string | null;
      total: string;
    }[]
  >`
    SELECT s.id::text AS seat_id, s.audience, s.user_id::text AS user_id,
           s.student_id::text AS student_id,
           COALESCE(NULLIF(btrim(concat_ws(' ', st.first_name, st.last_name)), ''), u.display_name, u.email) AS name,
           u.email, s.assigned_at, s.assigned_by_platform, s.unassigned_at,
           o.provider, o.overlap_days, o.credit_minor::text AS credit_minor, o.renewal_action,
           o.renewal_status,
           count(*) OVER ()::text AS total
    FROM app.license_seats AS s
    JOIN app.users AS u ON u.id = s.user_id AND u.school_id = s.school_id
    LEFT JOIN app.students AS st ON st.id = s.student_id AND st.school_id = s.school_id
    LEFT JOIN LATERAL (
      SELECT provider, overlap_days, credit_minor, renewal_action, renewal_status
      FROM app.license_seat_overlaps AS ov
      WHERE ov.school_id = s.school_id AND ov.seat_id = s.id
      ORDER BY ov.created_at DESC
      LIMIT 1
    ) AS o ON true
    WHERE s.school_id = current_setting('app.school_id')::uuid
      AND s.license_id = ${licenseId}::uuid
      ${input.audience ? tx`AND s.audience = ${input.audience}` : tx``}
      ${input.status === "active" ? tx`AND s.unassigned_at IS NULL` : tx``}
      ${input.status === "unassigned" ? tx`AND s.unassigned_at IS NOT NULL` : tx``}
      ${pattern ? tx`AND (u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern} OR concat_ws(' ', st.first_name, st.last_name) ILIKE ${pattern})` : tx``}
    ORDER BY s.unassigned_at IS NOT NULL, lower(COALESCE(u.display_name, u.email)), s.assigned_at DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
  return {
    seats: rows.map((row) => ({
      seatId: row.seat_id,
      audience: row.audience,
      userId: row.user_id,
      studentId: row.student_id,
      name: row.name,
      email: row.email,
      assignedAt: row.assigned_at.toISOString(),
      assignedByPlatform: row.assigned_by_platform,
      unassignedAt: row.unassigned_at?.toISOString() ?? null,
      overlap: row.renewal_action
        ? {
            provider: row.provider,
            overlapDays: row.overlap_days ?? 0,
            creditMinor: row.credit_minor === null ? null : Number(row.credit_minor),
            renewalAction: row.renewal_action,
            renewalStatus: row.renewal_status!,
          }
        : null,
    })),
    total: Number(rows[0]?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------------
// Usage and change requests
// ---------------------------------------------------------------------------------------------------

export interface FeatureUsageView {
  feature: FeatureKey;
  unit: FeatureUsageUnit | null;
  used: number;
}

export interface OfferedTierFeature {
  key: FeatureKey;
  name: string;
  unit: FeatureUsageUnit | null;
  /** The tier's monthly limit (the code's default where the tier states none); null is unlimited. */
  monthlyLimit: number | null;
  status: "active" | "paused";
}

export interface OfferedTier {
  id: string;
  code: string;
  displayName: string;
  description: string | null;
  audience: Audience;
  rank: number;
  isActive: boolean;
  includesAllFeatures: boolean;
  features: OfferedTierFeature[];
}

/**
 * What each tier gives, for the school: every active tier, and any retired one its license still
 * uses, with the features it includes and their monthly limits. A tier with `includes_all_features`
 * lists every feature of its audience. Prices are not here -- a school sees prices on its quotes --
 * and hidden features are not listed.
 */
export async function listOfferedTiers(
  tx: TransactionSql,
  license: LicenseRecord | null,
): Promise<OfferedTier[]> {
  const current = license
    ? AUDIENCES.map((a) => planIdFor(license, a)).filter((id): id is string => id !== null)
    : [];
  const [plans, included, settings] = await Promise.all([
    tx<
      {
        id: string;
        code: string;
        display_name: string;
        description: string | null;
        audience: Audience;
        rank: number;
        is_active: boolean;
        includes_all_features: boolean;
      }[]
    >`
      SELECT id::text AS id, code, display_name, description, audience, rank, is_active,
             includes_all_features
      FROM app.plans
      WHERE audience IS NOT NULL AND (is_active OR id = ANY(${current}::uuid[]))
      ORDER BY audience, rank, display_name
    `,
    tx<{ plan_id: string; feature_key: FeatureKey; monthly_limit: number | null }[]>`
      SELECT plan_id::text AS plan_id, feature_key, monthly_limit FROM app.plan_features
    `,
    tx<{ key: FeatureKey; display_name: string; status: "active" | "paused" | "hidden" }[]>`
      SELECT key, display_name, status FROM app.features
    `,
  ]);

  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    displayName: plan.display_name,
    description: plan.description,
    audience: plan.audience,
    rank: plan.rank,
    isActive: plan.is_active,
    includesAllFeatures: plan.includes_all_features,
    features: FEATURE_KEYS.flatMap((key): OfferedTierFeature[] => {
      const feature = FEATURES[key];
      const setting = settings.find((row) => row.key === key);
      if (feature.audience !== plan.audience || !setting || setting.status === "hidden") return [];
      const row = included.find((r) => r.plan_id === plan.id && r.feature_key === key);
      if (!row && !plan.includes_all_features) return [];
      return [
        {
          key,
          name: setting.display_name,
          unit: feature.unit,
          monthlyLimit: row ? row.monthly_limit : feature.defaultMonthlyLimit,
          status: setting.status,
        },
      ];
    }),
  }));
}

/** This month's units per feature, summed over the license's current seat holders. */
export async function licenseUsage(
  tx: TransactionSql,
  licenseId: string,
  now: Date = new Date(),
): Promise<FeatureUsageView[]> {
  const rows = await tx<{ feature_key: string; used: string }[]>`
    SELECT m.feature_key, sum(m.used)::text AS used
    FROM app.feature_usage_meters AS m
    WHERE m.school_id = current_setting('app.school_id')::uuid
      AND m.period_start = ${usagePeriodStart(now)}::date
      AND m.user_id IN (
        SELECT ls.user_id FROM app.license_seats AS ls
        WHERE ls.school_id = current_setting('app.school_id')::uuid
          AND ls.license_id = ${licenseId}::uuid
          AND ls.unassigned_at IS NULL
      )
    GROUP BY m.feature_key
  `;
  return FEATURE_KEYS.map((feature) => ({
    feature,
    unit: FEATURES[feature].unit,
    used: Number(rows.find((row) => row.feature_key === feature)?.used ?? 0),
  }));
}

export interface ChangeRequestInput {
  studentSeats?: number | null;
  teacherSeats?: number | null;
  parentSeats?: number | null;
  includeFamilyPlus?: boolean | null;
  /** The tier wanted per audience (session 5); omitted or null is "no change". */
  studentPlanId?: string | null;
  teacherPlanId?: string | null;
  parentPlanId?: string | null;
  note: string;
}

export interface ChangeRequestView {
  id: string;
  licenseId: string | null;
  studentSeats: number | null;
  teacherSeats: number | null;
  parentSeats: number | null;
  includeFamilyPlus: boolean | null;
  studentTier: TierRef | null;
  teacherTier: TierRef | null;
  parentTier: TierRef | null;
  note: string;
  status: "open" | "resolved" | "declined";
  requestedBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

interface ChangeRequestRow {
  id: string;
  license_id: string | null;
  student_seats: number | null;
  teacher_seats: number | null;
  parent_seats: number | null;
  include_family_plus: boolean | null;
  student_plan_id: string | null;
  teacher_plan_id: string | null;
  parent_plan_id: string | null;
  note: string;
  status: ChangeRequestView["status"];
  requested_by: string;
  created_at: Date;
  resolved_at: Date | null;
  resolution_note: string | null;
}

/** The requested tiers' names, in one read for every row. */
async function toChangeRequestViews(
  tx: TransactionSql,
  rows: readonly ChangeRequestRow[],
): Promise<ChangeRequestView[]> {
  const ids = [
    ...new Set(
      rows.flatMap((row) => [row.student_plan_id, row.teacher_plan_id, row.parent_plan_id]),
    ),
  ].filter((id): id is string => id !== null);
  const plans =
    ids.length === 0
      ? []
      : await tx<{ id: string; code: string; display_name: string }[]>`
          SELECT id::text AS id, code, display_name FROM app.plans WHERE id = ANY(${ids}::uuid[])
        `;
  const tier = (id: string | null): TierRef | null => {
    const plan = plans.find((p) => p.id === id);
    return plan ? { id: plan.id, code: plan.code, displayName: plan.display_name } : null;
  };
  return rows.map((row) => toChangeRequestView(row, tier));
}

function toChangeRequestView(
  row: ChangeRequestRow,
  tier: (id: string | null) => TierRef | null,
): ChangeRequestView {
  return {
    id: row.id,
    licenseId: row.license_id,
    studentSeats: row.student_seats,
    teacherSeats: row.teacher_seats,
    parentSeats: row.parent_seats,
    includeFamilyPlus: row.include_family_plus,
    studentTier: tier(row.student_plan_id),
    teacherTier: tier(row.teacher_plan_id),
    parentTier: tier(row.parent_plan_id),
    note: row.note,
    status: row.status,
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolutionNote: row.resolution_note,
  };
}

const CHANGE_REQUEST_COLUMNS = (tx: TransactionSql) => tx`
  id::text AS id, license_id::text AS license_id, student_seats, teacher_seats, parent_seats,
  include_family_plus, student_plan_id::text AS student_plan_id,
  teacher_plan_id::text AS teacher_plan_id, parent_plan_id::text AS parent_plan_id, note, status,
  requested_by::text AS requested_by, created_at, resolved_at, resolution_note
`;

/**
 * A school asks the super admin for different seats or tiers; the license itself is unchanged. A
 * requested tier must be an active tier of its audience (the trigger checks the audience; retired
 * tiers are not on offer).
 */
export async function createChangeRequest(
  tx: TransactionSql,
  schoolId: string,
  input: ChangeRequestInput,
  actor: LicenseActor,
): Promise<ChangeRequestView> {
  const license = await currentLicense(tx);
  const wanted = {
    student: input.studentPlanId ?? null,
    teacher: input.teacherPlanId ?? null,
    parent: input.parentPlanId ?? null,
  };
  const planIds = Object.values(wanted).filter((id): id is string => id !== null);
  if (planIds.length > 0) {
    const offered = await tx<{ id: string; audience: Audience }[]>`
      SELECT id::text AS id, audience FROM app.plans
      WHERE id = ANY(${planIds}::uuid[]) AND is_active AND audience IS NOT NULL
    `;
    const valid = AUDIENCES.every(
      (audience) =>
        wanted[audience] === null ||
        offered.some((plan) => plan.id === wanted[audience] && plan.audience === audience),
    );
    if (!valid) throw licenseError(422, ERROR_CODES.LICENSE_TIER_INVALID, actor.locale);
  }
  const [row] = await tx<ChangeRequestRow[]>`
    INSERT INTO app.license_change_requests (
      school_id, license_id, student_seats, teacher_seats, parent_seats, include_family_plus,
      student_plan_id, teacher_plan_id, parent_plan_id, note, requested_by
    ) VALUES (
      ${schoolId}::uuid, ${license?.id ?? null}::uuid, ${input.studentSeats ?? null},
      ${input.teacherSeats ?? null}, ${input.parentSeats ?? null}, ${input.includeFamilyPlus ?? null},
      ${wanted.student}::uuid, ${wanted.teacher}::uuid, ${wanted.parent}::uuid,
      ${input.note.trim()}, ${actor.userId}::uuid
    )
    RETURNING ${CHANGE_REQUEST_COLUMNS(tx)}
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "license_change_requests",
    targetId: row!.id,
    newValues: {
      license_id: row!.license_id,
      student_seats: row!.student_seats,
      teacher_seats: row!.teacher_seats,
      parent_seats: row!.parent_seats,
      include_family_plus: row!.include_family_plus,
      student_plan_id: row!.student_plan_id,
      teacher_plan_id: row!.teacher_plan_id,
      parent_plan_id: row!.parent_plan_id,
      note: row!.note,
    },
  });
  return (await toChangeRequestViews(tx, [row!]))[0]!;
}

export async function listChangeRequests(
  tx: TransactionSql,
  status?: ChangeRequestView["status"],
): Promise<ChangeRequestView[]> {
  const rows = await tx<ChangeRequestRow[]>`
    SELECT ${CHANGE_REQUEST_COLUMNS(tx)}
    FROM app.license_change_requests
    WHERE school_id = current_setting('app.school_id')::uuid
      ${status ? tx`AND status = ${status}` : tx``}
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return toChangeRequestViews(tx, rows);
}

/** The super admin closes a request (after changing the license, or not). */
export async function resolveChangeRequest(
  tx: TransactionSql,
  schoolId: string,
  requestId: string,
  input: { status: "resolved" | "declined"; note?: string | null },
  actor: LicenseActor,
): Promise<ChangeRequestView> {
  const [row] = await tx<ChangeRequestRow[]>`
    UPDATE app.license_change_requests
    SET status = ${input.status}, resolved_at = CURRENT_TIMESTAMP, resolved_by = ${actor.userId}::uuid,
        resolution_note = ${input.note?.trim() || null},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE id = ${requestId}::uuid
      AND school_id = current_setting('app.school_id')::uuid
      AND status = 'open'
    RETURNING ${CHANGE_REQUEST_COLUMNS(tx)}
  `;
  if (!row) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_change_requests",
    targetId: requestId,
    oldValues: { status: "open" },
    newValues: { status: input.status, resolution_note: row.resolution_note },
  });
  return (await toChangeRequestViews(tx, [row]))[0]!;
}

// ---------------------------------------------------------------------------------------------------
// Flows: one transaction, then what must happen after it commits
// ---------------------------------------------------------------------------------------------------

export interface LicensingDeps {
  database: Database | DatabasePools;
  /** Null disables direct cache invalidation; the outbox invalidators still apply every change. */
  redis: RedisClient | null;
  providers: RenewalProviders;
  logger: Logger;
  /** Object storage for payment receipts (session 3). Null answers 503 on the receipt routes. */
  storage?: StorageService | null;
}

/**
 * Run a change in one school transaction, then: invalidate the changed people's cache entries (the
 * outbox subscriber and worker do the same, version-guarded, so whichever lands first wins), and
 * make the provider calls that stop personal renewals.
 */
export async function runLicenseChange<T>(
  deps: LicensingDeps,
  schoolId: string,
  actor: LicenseActor,
  change: (tx: TransactionSql) => Promise<Changed<T>>,
): Promise<{ result: T; renewals: RenewalStopOutcome[] }> {
  let changed: Changed<T>;
  try {
    changed = await inSchool(deps.database, schoolId, actor, change);
  } catch (err) {
    rethrowLicenseDbError(err, actor.locale);
  }

  if (deps.redis) {
    for (const [userId, version] of changed.versions) {
      await invalidateEntitlementEntry(deps.redis, userEntitlementCacheKey(userId), version).catch(
        (err: unknown) => {
          deps.logger.warn(
            { err, school_id: schoolId, user_id: userId },
            "license change: direct cache invalidation failed; the outbox invalidator will apply it",
          );
        },
      );
    }
  }

  const renewals = await applyRenewalStops(changed.pending, {
    providers: deps.providers,
    schoolId,
    actor,
    logger: deps.logger,
    runInSchool: (fn) => inSchool(deps.database, schoolId, actor, fn),
  });
  return { result: changed.result, renewals };
}

/** A read in one school transaction, with database refusals mapped. */
export async function readInSchool<T>(
  deps: Pick<LicensingDeps, "database">,
  schoolId: string,
  actor: LicenseActor,
  read: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  try {
    return await inSchool(deps.database, schoolId, actor, read);
  } catch (err) {
    rethrowLicenseDbError(err, actor.locale);
  }
}

/** The school's own license for a seat change: refused when it has none it can assign on. */
export async function requireSchoolLicenseId(
  tx: TransactionSql,
  actor: LicenseActor,
): Promise<string> {
  const license = await currentLicense(tx);
  if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NONE, actor.locale);
  return license.id;
}
