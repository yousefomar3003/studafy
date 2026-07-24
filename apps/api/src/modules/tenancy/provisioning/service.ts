import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { bootstrapErpNextSite, teardownErpNextSite } from "../../../erpnext/bootstrap";
import { ErpNextClient } from "../../../erpnext/client";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { Logger } from "../../../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRIAL_DURATION_DAYS = 14;
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
 * Provision a newly verified school: create trial subscription, seed platform
 * defaults, bootstrap ERPNext site/company, and emit school.created.
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

  // ── 3. ERPNext bootstrap (async-capable, outside withTenantTx) ──────────
  if (!erpNextClient) {
    logger.warn(
      { school_id: schoolId },
      "ERPNext client not configured, skipping ERPNext bootstrap",
    );
    await markCompleted(database, params, logger);
    return { status: "completed", schoolId };
  }

  try {
    await provisionErpNext(database, erpNextClient, params, logger);
  } catch (error) {
    await compensateErpNext(database, erpNextClient, schoolId, logger, error);
    return {
      status: "failed",
      schoolId,
      error: error instanceof Error ? error.message : "ERPNext bootstrap failed",
    };
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
    // ── a. Create trial subscription with limits ────────────────────────────
    const trialExpiresAt = new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    // Find the default trial plan (or any active plan).
    const plans = await tx<{ id: string }[]>`
      SELECT id FROM app.plans WHERE is_active = true LIMIT 1
    `;
    const planId = plans.length > 0 ? plans[0].id : null;

    await tx`
      INSERT INTO app.subscriptions (
        school_id, plan_id, status, student_cap, trial_expires_at,
        current_period_start, current_period_end, provisioning_status
      ) VALUES (
        ${params.schoolId}::uuid,
        ${planId}::uuid,
        'trialing'::app.subscription_status,
        ${DEFAULT_STUDENT_CAP},
        ${trialExpiresAt.toISOString()}::timestamptz,
        CURRENT_TIMESTAMP,
        ${trialExpiresAt.toISOString()}::timestamptz,
        'in_progress'::app.provisioning_status
      )
      ON CONFLICT (school_id) DO UPDATE SET
        student_cap = ${DEFAULT_STUDENT_CAP},
        trial_expires_at = ${trialExpiresAt.toISOString()}::timestamptz,
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
        status: "trialing",
        student_cap: DEFAULT_STUDENT_CAP,
        trial_expires_at: trialExpiresAt.toISOString(),
      },
    });

    logger.info(
      { school_id: params.schoolId, trial_expires_at: trialExpiresAt.toISOString() },
      "local provisioning completed",
    );
  });
}

// ---------------------------------------------------------------------------
// Internal: ERPNext provisioning
// ---------------------------------------------------------------------------

async function provisionErpNext(
  database: Database,
  client: ErpNextClient,
  params: ProvisionTenantParams,
  logger: Logger,
): Promise<void> {
  // ── a. Create site config record (pending) ──────────────────────────────
  const siteName = `${params.slug}.erpnext.studafy.com`;
  const companyName = params.slug;
  const companyAbbr = params.slug.slice(0, 4).toUpperCase();

  await withTenantTx(database, params.tenantContext, async (tx) => {
    await tx`
      INSERT INTO app.erpnext_site_configs (
        school_id, site_name, company_name, company_abbr, status
      ) VALUES (
        ${params.schoolId}::uuid,
        ${siteName},
        ${companyName},
        ${companyAbbr},
        'in_progress'::app.provisioning_status
      )
      ON CONFLICT (school_id) DO UPDATE SET
        site_name = ${siteName},
        company_name = ${companyName},
        company_abbr = ${companyAbbr},
        status = 'in_progress'::app.provisioning_status
    `;
  });

  // ── b. Bootstrap ERPNext site and company ────────────────────────────────
  const result = await bootstrapErpNextSite(client, {
    schoolId: params.schoolId,
    slug: params.slug,
    country: params.country,
    currency: params.currency,
    adminEmail: params.adminEmail,
  });

  // ── c. Update site config with ERPNext IDs ───────────────────────────────
  await withTenantTx(database, params.tenantContext, async (tx) => {
    await tx`
      UPDATE app.erpnext_site_configs
      SET erpnext_site_id = ${result.siteName},
          erpnext_company_id = ${result.companyId},
          status = 'completed'::app.provisioning_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${params.schoolId}::uuid
    `;
  });

  logger.info(
    { school_id: params.schoolId, site_name: result.siteName, company_id: result.companyId },
    "ERPNext site bootstrap completed",
  );
}

// ---------------------------------------------------------------------------
// Internal: ERPNext compensation (rollback)
// ---------------------------------------------------------------------------

async function compensateErpNext(
  database: Database,
  client: ErpNextClient,
  schoolId: string,
  logger: Logger,
  originalError: unknown,
): Promise<void> {
  const errorMsg = originalError instanceof Error ? originalError.message : "Unknown ERPNext error";

  logger.error(
    { school_id: schoolId, error: errorMsg },
    "ERPNext bootstrap failed, attempting compensation",
  );

  // Try to read the site name for teardown.
  const configs = await database<{ site_name: string }[]>`
    SELECT site_name
    FROM app.erpnext_site_configs
    WHERE school_id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (configs.length > 0) {
    try {
      await teardownErpNextSite(client, configs[0].site_name);
      logger.info({ school_id: schoolId }, "ERPNext site teardown completed");
    } catch (teardownError) {
      logger.error(
        {
          school_id: schoolId,
          error: teardownError instanceof Error ? teardownError.message : "unknown",
        },
        "ERPNext site teardown failed during compensation",
      );
    }
  }

  // Mark site config as failed.
  await database`
    UPDATE app.erpnext_site_configs
    SET status = 'failed'::app.provisioning_status,
        last_error = ${errorMsg},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid
  `;
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
