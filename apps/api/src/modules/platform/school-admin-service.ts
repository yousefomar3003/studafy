/**
 * The platform console's per-school administration: edit a school's profile, read its usage, and
 * file and download whole-school data exports.
 *
 * Same isolation model as ./service.ts: global tables (`schools`, `countries`, `currencies`) are
 * read directly, and anything tenant-scoped is read after arming that one school's scope inside a
 * `withSystemTx`. Every write is audited twice -- in the affected school with a NULL actor and in
 * the operator's home school with the operator -- through `auditSchoolChange`.
 *
 * ## Exports
 *
 * A console export reuses the GDPR export pipeline end to end: one `app.data_subject_requests` row
 * (scope `tenant`, reason `platform_export`, no requester -- the operator is not a user of this
 * school, 000213), the maintenance queue's DSR export job (apps/workers dsr-processor ->
 * tenant-export.worker), and the data-retention sweep that deletes the bundle 30 days after it
 * completes. Its own reason keeps it apart from the closure export, which the closure sweep looks
 * up by reason `tenant_closure` only. There is no console path to erasure.
 */

import { dsrExportPrefix } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { setTenantScope, withSystemTx } from "../../db/tenant-tx";
import { requireStorage } from "../../lib/storage";
import { addDsrJob } from "../privacy/dsr-queue";
import { getStorageUsage } from "../storage/quota-service";

import { auditSchoolChange, buildSchoolDetail, loadSchool } from "./service";

import type { Actor } from "./service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { Queue } from "bullmq";
import type { TransactionSql } from "postgres";

const DAY_MS = 86_400_000;

/** Mirrors apps/workers data-retention-sweep.ts DSR_EXPORT_RETENTION_DAYS. */
export const PLATFORM_EXPORT_RETENTION_DAYS = 30;

/** How long a console download link stays valid. */
export const PLATFORM_EXPORT_LINK_TTL_SECONDS = 60 * 60;

/** GDPR Art. 12(3)'s one-month target, which every DSR row carries (sla_due_at). */
const EXPORT_SLA_DAYS = 30;

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface SchoolProfilePatch {
  name?: string;
  email?: string;
  countryCode?: string;
  currencyCode?: string;
  locale?: string;
  timezone?: string;
  reason: string;
}

/**
 * Whether the school has billing records priced in its current currency (or tied to its current
 * country's payment provider). Changing country or currency under them would mis-price renewals and
 * mismatch the provider's customer, so the console refuses it.
 */
async function hasBillingHistory(tx: TransactionSql, schoolId: string): Promise<boolean> {
  const [providerRow] = await tx<{ linked: boolean }[]>`
    SELECT (stripe_customer_id IS NOT NULL OR tap_customer_id IS NOT NULL) AS linked
    FROM app.schools WHERE id = ${schoolId}
  `;
  if (providerRow?.linked) return true;
  await setTenantScope(tx, schoolId);
  const [row] = await tx<{ billed: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM app.license_quotes)
      OR EXISTS (SELECT 1 FROM app.license_invoices)
      OR EXISTS (SELECT 1 FROM app.ai_subscriptions)
      OR EXISTS (SELECT 1 FROM app.storage_subscriptions)
    ) AS billed
  `;
  return row?.billed ?? false;
}

/**
 * Edits a school's profile: name, contact email, country, currency (app.schools) and default
 * language and timezone (app.school_settings). Fields that do not change are not written and not
 * audited; a patch that changes nothing returns the school as it is.
 */
export async function updateSchoolProfile(
  database: Database,
  schoolId: string,
  patch: SchoolProfilePatch,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    const school = await loadSchool(tx, schoolId, true);
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    const name = patch.name?.trim();
    if (name !== undefined && name !== school.name) {
      oldValues.name = school.name;
      newValues.name = name;
    }

    const email = patch.email?.trim();
    if (email !== undefined && email.toLowerCase() !== school.email.toLowerCase()) {
      const [taken] = await tx<{ id: string }[]>`
        SELECT id FROM app.schools
        WHERE normalized_email = ${email.toLowerCase()} AND id <> ${schoolId}
      `;
      if (taken) {
        throw new HTTPException(409, { message: "Another school already uses this email" });
      }
      oldValues.email = school.email;
      newValues.email = email;
    } else if (email !== undefined && email !== school.email) {
      // Same address, different capitalisation: a harmless display change.
      oldValues.email = school.email;
      newValues.email = email;
    }

    let countryId: string | null = null;
    const countryCode = patch.countryCode?.toUpperCase();
    if (countryCode !== undefined && countryCode !== school.country_code) {
      const [country] = await tx<{ id: string }[]>`
        SELECT id FROM app.countries WHERE alpha2_code = ${countryCode} AND is_active
      `;
      if (!country) throw new HTTPException(400, { message: `Unknown country ${countryCode}` });
      countryId = country.id;
      oldValues.countryCode = school.country_code;
      newValues.countryCode = countryCode;
    }

    let currencyId: string | null = null;
    const currencyCode = patch.currencyCode?.toUpperCase();
    if (currencyCode !== undefined && currencyCode !== school.currency_code) {
      const [currency] = await tx<{ id: string }[]>`
        SELECT id FROM app.currencies WHERE code = ${currencyCode} AND is_active
      `;
      if (!currency) throw new HTTPException(400, { message: `Unknown currency ${currencyCode}` });
      currencyId = currency.id;
      oldValues.currencyCode = school.currency_code;
      newValues.currencyCode = currencyCode;
    }

    if ((countryId || currencyId) && (await hasBillingHistory(tx, schoolId))) {
      throw new HTTPException(409, {
        message:
          "This school has billing records (a payment-provider customer, licence quotes or " +
          "invoices, or paid add-ons), so its country and currency can't change",
      });
    }

    if (name !== undefined && newValues.name !== undefined) {
      await tx`UPDATE app.schools SET name = ${name} WHERE id = ${schoolId}`;
    }
    if (newValues.email !== undefined && email !== undefined) {
      await tx`
        UPDATE app.schools SET email = ${email}, normalized_email = ${email.toLowerCase()}
        WHERE id = ${schoolId}
      `;
    }
    if (countryId) {
      await tx`UPDATE app.schools SET country_id = ${countryId} WHERE id = ${schoolId}`;
    }
    if (currencyId) {
      await tx`UPDATE app.schools SET default_currency_id = ${currencyId} WHERE id = ${schoolId}`;
    }
    const schoolChanged = Object.keys(newValues).length > 0;
    if (schoolChanged) {
      await tx`UPDATE app.schools SET updated_at = CURRENT_TIMESTAMP WHERE id = ${schoolId}`;
    }

    if (patch.locale !== undefined || patch.timezone !== undefined) {
      await setTenantScope(tx, schoolId);
      // Same first-write shape School settings uses (tenancy/settings/service.ts, ST-249): make
      // sure the row exists, then change only what was sent.
      await tx`
        INSERT INTO app.school_settings (school_id) VALUES (${schoolId})
        ON CONFLICT (school_id) DO NOTHING
      `;
      const [before] = await tx<{ locale: string; timezone: string }[]>`
        SELECT locale, timezone FROM app.school_settings FOR UPDATE
      `;
      const localeChanged = patch.locale !== undefined && patch.locale !== before?.locale;
      const timezoneChanged = patch.timezone !== undefined && patch.timezone !== before?.timezone;
      if (localeChanged) {
        oldValues.locale = before?.locale ?? null;
        newValues.locale = patch.locale;
      }
      if (timezoneChanged) {
        oldValues.timezone = before?.timezone ?? null;
        newValues.timezone = patch.timezone;
      }
      if (localeChanged || timezoneChanged) {
        await tx`
          UPDATE app.school_settings SET
            locale = COALESCE(${localeChanged ? patch.locale! : null}, locale),
            timezone = COALESCE(${timezoneChanged ? patch.timezone! : null}, timezone),
            updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
        `;
      }
    }

    if (Object.keys(newValues).length > 0) {
      await auditSchoolChange(tx, schoolId, actor, {
        action: "update",
        targetTable: "schools",
        targetId: schoolId,
        oldValues,
        newValues: { ...newValues, reason: patch.reason, source: "platform_console" },
      });
    }

    return buildSchoolDetail(tx, schoolId);
  });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const AUDIENCES = ["student", "teacher", "parent"] as const;
type Audience = (typeof AUDIENCES)[number];

/** One school's usage panel: every figure is one aggregate over the armed school, no per-row reads. */
export async function getSchoolUsage(database: Database, schoolId: string) {
  return withSystemTx(database, async (tx) => {
    await loadSchool(tx, schoolId);
    await setTenantScope(tx, schoolId);

    const people = await tx<{ role: string; active: number; invited: number }[]>`
      SELECT r.role::text AS role,
             count(DISTINCT u.id) FILTER (WHERE u.status = 'active')::int AS active,
             count(DISTINCT u.id) FILTER (WHERE u.status = 'invited')::int AS invited
      FROM app.user_roles r
      JOIN app.users u ON u.id = r.user_id AND u.school_id = r.school_id
      GROUP BY r.role
      ORDER BY r.role
    `;

    const [invitations] = await tx<{ pending: number }[]>`
      SELECT count(*)::int AS pending FROM app.invitations
      WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `;

    const storage = await getStorageUsage(tx);

    const [ai] = await tx<{ active_subscriptions: number; tokens: string }[]>`
      SELECT
        (SELECT count(*)::int FROM app.ai_subscriptions WHERE status = 'active') AS active_subscriptions,
        (SELECT COALESCE(sum(m.total_tokens), 0)::text
         FROM app.ai_usage_meters m
         JOIN app.ai_subscriptions s ON s.id = m.ai_subscription_id AND s.school_id = m.school_id
         WHERE s.status = 'active') AS tokens
    `;

    const [{ month_start: monthStart }] = await tx<{ month_start: string }[]>`
      SELECT to_char(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
        AS month_start
    `;
    const featureUses = await tx<{ feature_key: string; used: string }[]>`
      SELECT feature_key, sum(used)::text AS used
      FROM app.feature_usage_meters
      WHERE period_start = ${monthStart}::date
      GROUP BY feature_key
      ORDER BY feature_key
    `;

    const [activity] = await tx<{ last_activity_at: Date | null; active_30d: number }[]>`
      SELECT max(last_login_at) AS last_activity_at,
             count(*) FILTER (
               WHERE last_login_at >= CURRENT_TIMESTAMP - interval '30 days'
             )::int AS active_30d
      FROM app.users
    `;

    const [license] = await tx<
      {
        id: string;
        starts_at: Date;
        ends_at: Date;
        student_seats: number;
        teacher_seats: number;
        parent_seats: number;
      }[]
    >`
      SELECT id, starts_at, ends_at, student_seats, teacher_seats, parent_seats
      FROM app.school_licenses
      WHERE status = 'active'
      ORDER BY starts_at DESC
      LIMIT 1
    `;
    let licenseView = null;
    if (license) {
      const used = await tx<{ audience: Audience; used: number }[]>`
        SELECT audience, count(*)::int AS used
        FROM app.license_seats
        WHERE license_id = ${license.id} AND unassigned_at IS NULL
        GROUP BY audience
      `;
      const usedBy = new Map(used.map((row) => [row.audience, row.used]));
      const bought: Record<Audience, number> = {
        student: license.student_seats,
        teacher: license.teacher_seats,
        parent: license.parent_seats,
      };
      licenseView = {
        id: license.id,
        startsAt: iso(license.starts_at),
        endsAt: iso(license.ends_at),
        seats: AUDIENCES.map((audience) => ({
          audience,
          // eslint-disable-next-line security/detect-object-injection -- audience is from the fixed AUDIENCES list
          bought: bought[audience],
          used: usedBy.get(audience) ?? 0,
        })),
      };
    }

    return {
      people: people.map((row) => ({ role: row.role, active: row.active, invited: row.invited })),
      pendingInvitations: invitations?.pending ?? 0,
      storage: {
        bytesUsed: storage.bytesUsed,
        capBytes: storage.capBytes,
        fractionUsed: storage.capBytes > 0 ? storage.bytesUsed / storage.capBytes : null,
      },
      ai: {
        activeSubscriptions: ai?.active_subscriptions ?? 0,
        tokensThisPeriod: Number(ai?.tokens ?? 0),
        monthStart,
        featureUses: featureUses.map((row) => ({
          featureKey: row.feature_key,
          used: Number(row.used),
        })),
      },
      activity: {
        lastActivityAt: isoOrNull(activity?.last_activity_at ?? null),
        activeUsersLast30Days: activity?.active_30d ?? 0,
      },
      license: licenseView,
      generatedAt: new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

interface ExportRow {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  storage_key: string | null;
  failure_message: string | null;
  created_at: Date;
  completed_at: Date | null;
  export_deleted_at: Date | null;
}

const EXPORT_COLUMNS = (tx: TransactionSql) => tx`
  id, status::text AS status, storage_key, failure_message, created_at, completed_at,
  export_deleted_at
`;

function toExportView(row: ExportRow, presigned: { url: string; expiresAt: Date } | null = null) {
  return {
    id: row.id,
    status: row.status,
    createdAt: iso(row.created_at),
    completedAt: isoOrNull(row.completed_at),
    failureMessage: row.failure_message,
    expiresAt:
      row.status === "completed" && row.completed_at && !row.export_deleted_at
        ? iso(new Date(row.completed_at.getTime() + PLATFORM_EXPORT_RETENTION_DAYS * DAY_MS))
        : null,
    deletedAt: isoOrNull(row.export_deleted_at),
    downloadUrl: presigned?.url ?? null,
    downloadUrlExpiresAt: presigned ? iso(presigned.expiresAt) : null,
  };
}

/** The archive key of a completed, still-kept export, when it sits under its own export prefix. */
export function exportArchiveKey(row: ExportRow, schoolId: string): string | null {
  if (row.status !== "completed" || !row.storage_key || row.export_deleted_at) return null;
  return row.storage_key.startsWith(dsrExportPrefix(schoolId, row.id)) ? row.storage_key : null;
}

/** The school's console exports, newest first (the last 10). */
export async function listSchoolExports(database: Database, schoolId: string) {
  return withSystemTx(database, async (tx) => {
    await loadSchool(tx, schoolId);
    await setTenantScope(tx, schoolId);
    const rows = await tx<ExportRow[]>`
      SELECT ${EXPORT_COLUMNS(tx)}
      FROM app.data_subject_requests
      WHERE reason = 'platform_export'
      ORDER BY created_at DESC, id
      LIMIT 10
    `;
    return rows.map((row) => toExportView(row));
  });
}

/**
 * Files a whole-school export and queues it. One at a time per school: a second request while one
 * is queued or processing is refused, so an impatient double-click never builds two bundles.
 */
export async function createSchoolExport(
  database: Database,
  maintenanceQueue: Queue | null,
  schoolId: string,
  reason: string,
  actor: Actor,
) {
  if (!maintenanceQueue) {
    throw new HTTPException(503, { message: "The export queue is not configured" });
  }

  const row = await withSystemTx(database, async (tx) => {
    await loadSchool(tx, schoolId);
    await setTenantScope(tx, schoolId);
    // Serialises two concurrent requests for the same school on the school's settings-free lock.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`platform-export:${schoolId}`}, 0))`;
    const [inFlight] = await tx<{ id: string }[]>`
      SELECT id FROM app.data_subject_requests
      WHERE reason = 'platform_export' AND status IN ('queued', 'processing')
      LIMIT 1
    `;
    if (inFlight) {
      throw new HTTPException(409, { message: "An export of this school is already running" });
    }

    const [created] = await tx<ExportRow[]>`
      INSERT INTO app.data_subject_requests
        (school_id, request_type, subject_scope, reason, subject_user_id, requested_by_user_id,
         sla_due_at)
      VALUES (
        ${schoolId}, 'export', 'tenant', 'platform_export', NULL, NULL,
        CURRENT_TIMESTAMP + make_interval(days => ${EXPORT_SLA_DAYS})
      )
      RETURNING ${EXPORT_COLUMNS(tx)}
    `;
    await auditSchoolChange(tx, schoolId, actor, {
      action: "export",
      targetTable: "data_subject_requests",
      targetId: created!.id,
      newValues: { kind: "platform_export", reason, source: "platform_console" },
    });
    return created!;
  });

  try {
    await addDsrJob(maintenanceQueue, { id: row.id, requestType: "export" }, schoolId);
  } catch {
    // The row committed but nothing will process it: mark it failed so the console shows a
    // failure the operator can retry, instead of an export stuck `queued` forever.
    const failed = await withSystemTx(database, async (tx) => {
      await setTenantScope(tx, schoolId);
      const [updated] = await tx<ExportRow[]>`
        UPDATE app.data_subject_requests
        SET status = 'failed', failure_message = 'Failed to enqueue request',
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${row.id} AND status = 'queued'
        RETURNING ${EXPORT_COLUMNS(tx)}
      `;
      return updated ?? row;
    });
    throw new HTTPException(503, {
      message: `The export could not be queued (request ${failed.id}); try again`,
    });
  }

  return toExportView(row);
}

/**
 * One console export, with a short-lived download link when the bundle is ready and still kept.
 * Issuing a link is audited in both schools: it hands out the school's whole data set.
 */
export async function getSchoolExport(
  database: Database,
  storage: StorageService | null,
  schoolId: string,
  exportId: string,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    await loadSchool(tx, schoolId);
    await setTenantScope(tx, schoolId);
    const [row] = await tx<ExportRow[]>`
      SELECT ${EXPORT_COLUMNS(tx)}
      FROM app.data_subject_requests
      WHERE id = ${exportId} AND reason = 'platform_export'
    `;
    if (!row) throw new HTTPException(404, { message: "Export not found" });

    const key = exportArchiveKey(row, schoolId);
    if (!key) return toExportView(row);

    const presigned = await requireStorage(storage).presign(
      key,
      "GET",
      undefined,
      PLATFORM_EXPORT_LINK_TTL_SECONDS,
    );
    await auditSchoolChange(tx, schoolId, actor, {
      action: "read",
      targetTable: "data_subject_requests",
      targetId: row.id,
      newValues: { kind: "platform_export", download_link_issued: true },
    });
    return toExportView(row, presigned);
  });
}
