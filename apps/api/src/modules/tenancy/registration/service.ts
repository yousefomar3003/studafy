import { createHash, randomBytes } from "node:crypto";

import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import { verifyCaptcha } from "./captcha";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterSchoolParams {
  schoolName: string;
  slug: string;
  email: string;
  countryId: string;
  defaultCurrencyId: string;
  adminEmail: string;
  adminName?: string;
  captchaToken: string;
  clientIp?: string;
}

export interface RegisterSchoolResult {
  schoolId: string;
  slug: string;
  schoolName: string;
  adminUserId: string;
  adminEmail: string;
  invitationToken: string;
  invitationExpiresAt: Date;
  verificationToken: string;
  verificationExpiresAt: Date;
}

// ---------------------------------------------------------------------------
// Token helpers (same pattern as invitation service)
// ---------------------------------------------------------------------------

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVITATION_EXPIRY_DAYS = 7;
const VERIFICATION_EXPIRY_HOURS = 24;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Register a new school, create its first ORG_ADMIN user, and issue an activation invitation.
 *
 * All writes run inside a single database transaction. The school INSERT is delegated to the
 * SECURITY DEFINER function app.register_school() (the API never holds admin credentials),
 * then the transaction switches to studafy_app for tenant-scoped inserts (users, roles,
 * invitations, audit, outbox).
 *
 * @throws HTTPException 409 with SCHOOL_SLUG_DUPLICATE or SCHOOL_EMAIL_DUPLICATE
 * @throws HTTPException 400 with CAPTCHA_INVALID when the captcha token is invalid
 * @throws HTTPException 409 with CONFLICT_DUPLICATE_ENTRY on race-condition unique violations
 */
export async function registerSchool(
  database: Database,
  params: RegisterSchoolParams,
  logger: Logger,
  options: { captchaSecretKey?: string; now?: () => number } = {},
): Promise<RegisterSchoolResult> {
  // ── 1. Captcha verification ────────────────────────────────────────────
  const captchaValid = await verifyCaptcha(
    params.captchaToken,
    options.captchaSecretKey,
    params.clientIp,
  );
  if (!captchaValid) {
    throw new HTTPException(400, { message: "Captcha verification failed." });
  }

  // ── 2. Normalize inputs ────────────────────────────────────────────────
  const normalizedEmail = params.email.toLowerCase().trim();
  const normalizedAdminEmail = params.adminEmail.toLowerCase().trim();
  const now = options.now?.() ?? Date.now();
  const expiresAt = new Date(now + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const verificationExpiresAt = new Date(now + VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000);

  // ── 3. Pre-check uniqueness (advisory — DB constraints are the true guard) ──
  await checkDuplicates(database, params.slug, normalizedEmail);

  // ── 4. Transaction ─────────────────────────────────────────────────────
  return database.begin(async (tx) => {
    // Phase A: Create the school via SECURITY DEFINER function (global table, no RLS).
    const schools = await tx<{ register_school: string }[]>`
      SELECT app.register_school(
        ${params.slug},
        ${params.schoolName},
        ${params.email},
        ${normalizedEmail},
        ${params.countryId}::uuid,
        ${params.defaultCurrencyId}::uuid
      )
    `;

    if (schools.length === 0) {
      throw new HTTPException(500, { message: "Failed to create school." });
    }

    const schoolId = schools[0].register_school;

    // Phase B: Switch to the runtime role and set tenant context for remaining inserts.
    await tx`
      SELECT
        set_config('role', 'studafy_app', true),
        set_config('app.school_id', ${schoolId}, true)
    `;

    // ── 4a. Create default school settings ────────────────────────────────
    await tx`
      INSERT INTO app.school_settings (school_id)
      VALUES (${schoolId}::uuid)
    `;

    // ── 4b. Create admin user ──────────────────────────────────────────────
    // ── 4a. Store email verification token ─────────────────────────────────
    const verificationToken = generateToken();
    const verificationTokenHash = hashToken(verificationToken);

    await tx`
      UPDATE app.schools
      SET email_verification_token_hash = ${verificationTokenHash}::bytea,
          email_verification_expires_at = ${verificationExpiresAt.toISOString()}::timestamptz
      WHERE id = ${schoolId}::uuid
    `;

    // ── 4b. Audit: email verification token created ────────────────────────
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "schools",
      targetId: schoolId,
      newValues: {
        email_verification_token_hash: "[REDACTED]",
        email_verification_expires_at: verificationExpiresAt.toISOString(),
      },
    });

    // ── 4c. Domain event: verification email ───────────────────────────────
    await emit(tx, DOMAIN_EVENTS.SCHOOL_VERIFICATION_EMAIL_SENT, {
      schoolId,
      email: params.email,
      expiresAt: verificationExpiresAt.toISOString(),
    });

    // ── 4d. Create admin user ──────────────────────────────────────────────
    const users = await tx<{ id: string }[]>`
      INSERT INTO app.users (
        school_id, email, normalized_email, display_name, status
      ) VALUES (
        ${schoolId}::uuid,
        ${params.adminEmail},
        ${normalizedAdminEmail},
        ${params.adminName ?? null},
        'invited'::app.user_status
      )
      RETURNING id
    `;

    if (users.length === 0) {
      throw new HTTPException(500, { message: "Failed to create administrator user." });
    }

    const adminUserId = users[0].id;

    // ── 4e. Assign ORG_ADMIN role ──────────────────────────────────────────
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (
        ${schoolId}::uuid,
        ${adminUserId}::uuid,
        'ORG_ADMIN'::app.user_role
      )
    `;

    // ── 4f. Create activation invitation ────────────────────────────────────
    const token = generateToken();
    const tokenHash = hashToken(token);

    const invitations = await tx<{ id: string }[]>`
      INSERT INTO app.invitations (
        school_id, email, normalized_email, role,
        token_hash, invited_by_user_id, expires_at
      ) VALUES (
        ${schoolId}::uuid,
        ${params.adminEmail},
        ${normalizedAdminEmail},
        'ORG_ADMIN'::app.user_role,
        ${tokenHash}::bytea,
        ${adminUserId}::uuid,
        ${expiresAt.toISOString()}::timestamptz
      )
      RETURNING id
    `;

    if (invitations.length === 0) {
      throw new HTTPException(500, { message: "Failed to create invitation." });
    }

    const invitationId = invitations[0].id;

    // ── 4g. Audit: school creation ─────────────────────────────────────────
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "schools",
      targetId: schoolId,
      newValues: {
        slug: params.slug,
        name: params.schoolName,
        email: params.email,
        status: "registered",
        country_id: params.countryId,
        default_currency_id: params.defaultCurrencyId,
      },
    });

    // ── 4e. Audit: default settings creation ───────────────────────────────
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "school_settings",
      targetId: schoolId,
      newValues: {
        locale: "en",
        timezone: "Africa/Casablanca",
        grading_scheme: "letter",
        invitation_expiry_days: 7,
        attendance_alert_threshold: 75,
        absence_alert_threshold: 50,
      },
    });

    // ── 4f. Audit: user creation ───────────────────────────────────────────
    // ── 4h. Audit: user creation ───────────────────────────────────────────
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "users",
      targetId: adminUserId,
      newValues: {
        email: params.adminEmail,
        display_name: params.adminName ?? null,
        status: "invited",
      },
    });

    // ── 4g. Audit: invitation creation ─────────────────────────────────────
    // ── 4i. Audit: invitation creation ─────────────────────────────────────
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "invitations",
      targetId: invitationId,
      newValues: {
        email: params.adminEmail,
        role: "ORG_ADMIN",
        expires_at: expiresAt.toISOString(),
      },
    });

    // ── 4j. Domain events ──────────────────────────────────────────────────
    await emit(tx, DOMAIN_EVENTS.SCHOOL_REGISTERED, {
      schoolId,
      adminUserId,
      email: params.adminEmail,
      slug: params.slug,
    });

    await emit(tx, DOMAIN_EVENTS.INVITATION_SENT, {
      invitationId,
      email: params.adminEmail,
      role: "ORG_ADMIN",
      expiresAt: expiresAt.toISOString(),
      invitedByUserId: adminUserId,
    });

    logger.info(
      { school_id: schoolId, slug: params.slug, admin_email: params.adminEmail },
      "school registered",
    );

    return {
      schoolId,
      slug: params.slug,
      schoolName: params.schoolName,
      adminUserId,
      adminEmail: params.adminEmail,
      invitationToken: token,
      invitationExpiresAt: expiresAt,
      verificationToken,
      verificationExpiresAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Duplicate check
// ---------------------------------------------------------------------------

/**
 * Advisory pre-check for slug and email uniqueness.
 *
 * This is not a lock — a concurrent request could slip in between the check and the INSERT.
 * The DB unique constraints catch that race and the INSERT throws a PostgreSQL unique-violation
 * (error code 23505), which the caller handles. This check exists to give the caller a clear,
 * field-specific error message instead of a raw database error.
 */
async function checkDuplicates(
  database: Database,
  slug: string,
  normalizedEmail: string,
): Promise<void> {
  const existing = await database<{ slug: string; normalized_email: string }[]>`
    SELECT slug, normalized_email
    FROM app.schools
    WHERE slug = ${slug} OR normalized_email = ${normalizedEmail}
    LIMIT 1
  `;

  if (existing.length === 0) return;

  const row = existing[0];
  if (row.slug === slug) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SCHOOL_SLUG_DUPLICATE,
      "This school slug is already taken.",
    );
  }
  throw new CodedHttpException(
    409,
    ERROR_CODES.SCHOOL_EMAIL_DUPLICATE,
    "A school with this email already exists.",
  );
}
