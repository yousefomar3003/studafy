import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { ErpNextClient } from "../../../erpnext/client";
import type { Logger } from "../../../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Studafy is free for schools: every school is on the `free` plan (migration 000145), active and
 * never ending. The only paid products are per-student add-ons such as the AI add-on.
 */
export const FREE_PLAN_CODE = "free";
/** "Never": the column is NOT NULL and must lie after the period start. */
export const FREE_PLAN_PERIOD_END = "9999-12-31T00:00:00Z";
const DEFAULT_STUDENT_CAP = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvisioningStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ProvisionTenantParams {
  schoolId: string;
  slug: string;
  schoolName: string;
  countryId: string;
  country: string;
  defaultCurrencyId: string;
  currency: string;
  adminUserId: string;
  adminEmail: string;
  tenantContext: TenantContext;
}

export interface ProvisionTenantResult {
  status: ProvisioningStatus;
  schoolId: string;
  error?: string;
}

export interface ProvisioningStatusResult {
  schoolId: string;
  status: ProvisioningStatus;
  erpNextSite?: {
    siteName: string;
    companyName: string;
    status: ProvisioningStatus;
  } | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Provision a newly verified school: put it on the free plan, seed platform
 * defaults, register the school's ERPNext site (created by an operator, activated on first use),
 * and emit school.created.
 *
 * Strictly idempotent — retrying with the same schoolId returns the existing
 * provisioned state without duplicating rows or ERPNext entities.
 *
 * @throws CodedHttpException 409 with PROVISIONING_IN_PROGRESS on concurrent attempt
 * @throws CodedHttpException 500 with PROVISIONING_FAILED on unrecoverable failure
 */
export async function provisionTenant(
  database: Database,
  params: ProvisionTenantParams,
  logger: Logger,
  erpNextClient: ErpNextClient | null,
): Promise<ProvisionTenantResult> {
  const { schoolId } = params;

  // ── 1. Idempotency check ────────────────────────────────────────────────
  const existing = await database<{ provisioning_status: ProvisioningStatus }[]>`
    SELECT provisioning_status
    FROM app.subscriptions
    WHERE school_id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (existing.length > 0) {
    const current = existing[0].provisioning_status;
    if (current === "completed") {
      logger.info(
        { school_id: schoolId },
        "provisioning already completed, returning existing state",
      );
      return { status: "completed", schoolId };
    }
    if (current === "in_progress") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.PROVISIONING_IN_PROGRESS,
        "Provisioning is already in progress for this school.",
      );
    }
    // 'failed' or 'pending' → allow retry
  }

  // ── 2. Local Postgres provisioning ──────────────────────────────────────
  try {
    await provisionLocal(database, params, logger);
  } catch (error) {
    await markFailed(database, schoolId, logger, error);
    throw new CodedHttpException(
      500,
      ERROR_CODES.PROVISIONING_FAILED,
      "Local tenant provisioning failed.",
    );
  }

  // ── 3. ERPNext site registration ─────────────────────────────────────────
  // Only where the integration is configured. The site itself is created by an operator
  // (erpnext-new-site.sh) and activates on the school's first finance request -- see
  // registerErpNextSite -- so a school's own provisioning never waits on, or fails with, ERPNext.
  if (!erpNextClient) {
    logger.warn({ school_id: schoolId }, "ERPNext not configured, skipping site registration");
  } else {
    try {
      await registerErpNextSite(database, params, logger);
    } catch (error) {
      await markFailed(database, schoolId, logger, error);
      throw new CodedHttpException(
        500,
        ERROR_CODES.PROVISIONING_FAILED,
        "ERPNext site registration failed.",
      );
    }
  }

  // ── 4. Complete ─────────────────────────────────────────────────────────
  await markCompleted(database, params, logger);

  logger.info(
    { school_id: schoolId, slug: params.slug },
    "tenant provisioning completed successfully",
  );

  return { status: "completed", schoolId };
}

/**
 * Read the provisioning status for a school.
 */
export async function getProvisioningStatus(
  database: Database,
  schoolId: string,
): Promise<ProvisioningStatusResult> {
  const school = await database<{ provisioning_status: ProvisioningStatus }[]>`
    SELECT provisioning_status
    FROM app.schools
    WHERE id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (school.length === 0) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found.");
  }

  const siteConfig = await database<
    {
      site_name: string;
      company_name: string;
      status: ProvisioningStatus;
    }[]
  >`
    SELECT site_name, company_name, status
    FROM app.erpnext_site_configs
    WHERE school_id = ${schoolId}::uuid
    LIMIT 1
  `;

  return {
    schoolId,
    status: school[0].provisioning_status,
    erpNextSite:
      siteConfig.length > 0
        ? {
            siteName: siteConfig[0].site_name,
            companyName: siteConfig[0].company_name,
            status: siteConfig[0].status,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Internal: Local provisioning
// ---------------------------------------------------------------------------

async function provisionLocal(
  database: Database,
  params: ProvisionTenantParams,
  logger: Logger,
): Promise<void> {
  await withTenantTx(database, params.tenantContext, async (tx) => {
    // ── a. Put the school on the free plan ─────────────────────────────────
    const plans = await tx<{ id: string }[]>`
      SELECT id FROM app.plans WHERE code = ${FREE_PLAN_CODE} LIMIT 1
    `;
    const planId = plans.length > 0 ? plans[0].id : null;

    await tx`
      INSERT INTO app.subscriptions (
        school_id, plan_id, status, student_cap, trial_expires_at,
        current_period_start, current_period_end, provisioning_status
      ) VALUES (
        ${params.schoolId}::uuid,
        ${planId}::uuid,
        'active'::app.subscription_status,
        ${DEFAULT_STUDENT_CAP},
        NULL,
        CURRENT_TIMESTAMP,
        ${FREE_PLAN_PERIOD_END}::timestamptz,
        'in_progress'::app.provisioning_status
      )
      ON CONFLICT (school_id) DO UPDATE SET
        provisioning_status = 'in_progress'::app.provisioning_status
    `;

    // ── b. Seed notification preferences for admin user ─────────────────────
    const notificationTypes = [
      "ASSIGNMENT_DUE_SOON",
      "GRADE_POSTED",
      "ENROLLMENT_APPROVED",
      "COURSE_PUBLISHED",
      "DISCUSSION_REPLY",
      "STUDY_GROUP_INVITE",
      "CERTIFICATE_ISSUED",
      "SUPPORT_MESSAGE",
    ] as const;
    const channels = ["in_app", "email"] as const;

    for (const nt of notificationTypes) {
      for (const ch of channels) {
        await tx`
          INSERT INTO app.notification_preferences (
            school_id, user_id, notification_type, channel, enabled
          ) VALUES (
            ${params.schoolId}::uuid,
            ${params.adminUserId}::uuid,
            ${nt}::app.notification_type,
            ${ch}::app.notification_channel,
            true
          )
          ON CONFLICT DO NOTHING
        `;
      }
    }

    // ── c. Confirm admin user has ORG_ADMIN role ────────────────────────────
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (
        ${params.schoolId}::uuid,
        ${params.adminUserId}::uuid,
        'ORG_ADMIN'::app.user_role
      )
      ON CONFLICT DO NOTHING
    `;

    // ── d. Audit log ────────────────────────────────────────────────────────
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "subscriptions",
      targetId: params.schoolId,
      newValues: {
        status: "active",
        plan: FREE_PLAN_CODE,
        student_cap: DEFAULT_STUDENT_CAP,
      },
    });

    logger.info(
      { school_id: params.schoolId, plan: FREE_PLAN_CODE },
      "local provisioning completed",
    );
  });
}

// ---------------------------------------------------------------------------
// Internal: ERPNext site registration
// ---------------------------------------------------------------------------

/**
 * The site hostname a school's ERPNext site is created under: `<slug>.<ERPNEXT_SITE_DOMAIN>`.
 * Production's domain is `erpnext.studafy.com`; locally it is `erpnext.localhost`.
 */
export function erpNextSiteName(slug: string): string {
  return `${slug}.${process.env.ERPNEXT_SITE_DOMAIN || "erpnext.studafy.com"}`;
}

/**
 * Record the school's ERPNext site as awaiting creation.
 *
 * A Frappe site can only be created by bench (`bench new-site`), never over the REST API, so the API
 * cannot create one itself. An operator runs `infra/deploy/scripts/erpnext-new-site.sh <env>
 * <site>`, which creates the site, finishes ERPNext's setup wizard (the school's company) and sets
 * the integration key. The credential resolver (modules/finance/client/credential-resolver.ts)
 * then notices the site answering on the school's next finance request and marks it 'completed'
 * with its company -- so this row is all provisioning has to write.
 */
async function registerErpNextSite(
  database: Database,
  params: ProvisionTenantParams,
  logger: Logger,
): Promise<void> {
  const siteName = erpNextSiteName(params.slug);
  const companyAbbr = params.slug
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 4)
    .toUpperCase();

  await withTenantTx(database, params.tenantContext, async (tx) => {
    await tx`
      INSERT INTO app.erpnext_site_configs (
        school_id, site_name, company_name, company_abbr, status
      ) VALUES (
        ${params.schoolId}::uuid,
        ${siteName},
        ${params.schoolName},
        ${companyAbbr},
        'pending'::app.provisioning_status
      )
      ON CONFLICT (school_id) DO NOTHING
    `;
  });

  logger.info(
    { school_id: params.schoolId, site_name: siteName },
    "ERPNext site registered; awaiting erpnext-new-site.sh",
  );
}

// ---------------------------------------------------------------------------
// Internal: Status transitions
// ---------------------------------------------------------------------------

async function markCompleted(
  database: Database,
  params: ProvisionTenantParams,
  logger: Logger,
): Promise<void> {
  await withTenantTx(database, params.tenantContext, async (tx) => {
    // Mark subscription as completed.
    await tx`
      UPDATE app.subscriptions
      SET provisioning_status = 'completed'::app.provisioning_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${params.schoolId}::uuid
    `;

    // Mark school as completed.
    await tx`
      UPDATE app.schools
      SET provisioning_status = 'completed'::app.provisioning_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${params.schoolId}::uuid
    `;

    // Emit school.created event.
    await emit(tx, DOMAIN_EVENTS.SCHOOL_CREATED, {
      schoolId: params.schoolId,
      slug: params.slug,
      name: params.schoolName,
      countryId: params.countryId,
      defaultCurrencyId: params.defaultCurrencyId,
    });

    // Audit log.
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "subscriptions",
      targetId: params.schoolId,
      newValues: { provisioning_status: "completed" },
    });
  });
}

async function markFailed(
  database: Database,
  schoolId: string,
  logger: Logger,
  error: unknown,
): Promise<void> {
  const errorMsg = error instanceof Error ? error.message : "Unknown error";

  try {
    await database`
      UPDATE app.subscriptions
      SET provisioning_status = 'failed'::app.provisioning_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid
    `;
    await database`
      UPDATE app.schools
      SET provisioning_status = 'failed'::app.provisioning_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${schoolId}::uuid
    `;
  } catch (updateError) {
    logger.error(
      {
        school_id: schoolId,
        error: updateError instanceof Error ? updateError.message : "unknown",
      },
      "failed to update provisioning status to failed",
    );
  }

  logger.error({ school_id: schoolId, error: errorMsg }, "provisioning marked as failed");
}
