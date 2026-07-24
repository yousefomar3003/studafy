import { createHash, randomBytes } from "node:crypto";

import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VERIFICATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const VERIFICATION_EXPIRY_HOURS = 24;

// ---------------------------------------------------------------------------
// Token helpers (same pattern as invitation service)
// ---------------------------------------------------------------------------

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifySchoolEmailResult {
  schoolId: string;
  slug: string;
  schoolName: string;
  email: string;
  countryId: string;
  defaultCurrencyId: string;
  adminUserId: string;
  adminEmail: string;
}

export interface ResendVerificationResult {
  email: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Verify a school's email address using a one-time verification token.
 *
 * Looks up the school by token hash (global table, no RLS), checks expiry,
 * consumes the token, sets email_verified_at, and moves the school from
 * 'registered' to 'active' (trial begins). Also returns the school's
 * admin user information needed for provisioning.
 *
 * @throws CodedHttpException 400 with VERIFICATION_TOKEN_INVALID for malformed or unknown tokens
 * @throws CodedHttpException 409 with VERIFICATION_TOKEN_EXPIRED for expired tokens
 * @throws CodedHttpException 409 with VERIFICATION_TOKEN_CONSUMED for already-used tokens
 */
export async function verifySchoolEmail(
  database: Database,
  rawToken: string,
  logger: Logger,
  options: { now?: () => number } = {},
): Promise<VerifySchoolEmailResult> {
  if (!VERIFICATION_TOKEN_PATTERN.test(rawToken)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VERIFICATION_TOKEN_INVALID,
      "Invalid verification token.",
    );
  }

  const tokenHash = hashToken(rawToken);
  const now = options.now?.() ?? Date.now();

  // Look up the school by token hash. app.schools is a global table without RLS,
  // so studafy_app can SELECT directly.
  const rows = await database<
    {
      id: string;
      slug: string;
      name: string;
      email: string;
      country_id: string;
      default_currency_id: string;
      email_verified_at: Date | null;
      email_verification_expires_at: Date | null;
    }[]
  >`
    SELECT
      id, slug, name, email, country_id, default_currency_id,
      email_verified_at,
      email_verification_expires_at
    FROM app.schools
    WHERE email_verification_token_hash = ${tokenHash}::bytea
    LIMIT 1
  `;

  if (rows.length === 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VERIFICATION_TOKEN_INVALID,
      "Invalid verification token.",
    );
  }

  const school = rows[0];

  // Already verified — idempotent success.
  if (school.email_verified_at !== null) {
    // Look up admin user for provisioning info.
    const admin = await database<{ id: string; email: string }[]>`
      SELECT id, email
      FROM app.users
      WHERE school_id = ${school.id}::uuid
      ORDER BY created_at ASC
      LIMIT 1
    `;
    return {
      schoolId: school.id,
      slug: school.slug,
      schoolName: school.name,
      email: school.email,
      countryId: school.country_id,
      defaultCurrencyId: school.default_currency_id,
      adminUserId: admin.length > 0 ? admin[0].id : "",
      adminEmail: admin.length > 0 ? admin[0].email : "",
    };
  }

  // Check expiry.
  if (
    school.email_verification_expires_at !== null &&
    school.email_verification_expires_at.getTime() <= now
  ) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.VERIFICATION_TOKEN_EXPIRED,
      "Verification token has expired.",
    );
  }

  // Look up admin user before the transaction (for provisioning info).
  const adminRows = await database<{ id: string; email: string }[]>`
    SELECT id, email
    FROM app.users
    WHERE school_id = ${school.id}::uuid
    ORDER BY created_at ASC
    LIMIT 1
  `;

  const adminUserId = adminRows.length > 0 ? adminRows[0].id : "";
  const adminEmail = adminRows.length > 0 ? adminRows[0].email : "";

  // Consume the token and activate the school in one transaction.
  await database.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;

    const updated = await tx<{ id: string }[]>`
      UPDATE app.schools
      SET email_verified_at = CURRENT_TIMESTAMP,
          email_verification_token_hash = NULL,
          email_verification_expires_at = NULL,
          status = 'active'::app.school_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${school.id}::uuid
        AND email_verified_at IS NULL
        AND email_verification_token_hash = ${tokenHash}::bytea
      RETURNING id
    `;

    if (updated.length === 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.VERIFICATION_TOKEN_CONSUMED,
        "Verification token has already been used.",
      );
    }

    // Audit: email verified + school activated.
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "schools",
      targetId: school.id,
      oldValues: {
        status: "registered",
        email_verified_at: null,
      },
      newValues: {
        status: "active",
        email_verified_at: new Date().toISOString(),
      },
    });

    // Domain event.
    await emit(tx, DOMAIN_EVENTS.SCHOOL_EMAIL_VERIFIED, {
      schoolId: school.id,
      email: school.email,
      slug: school.slug,
    });

    logger.info(
      { school_id: school.id, slug: school.slug },
      "school email verified, status moved to active",
    );
  });

  return {
    schoolId: school.id,
    slug: school.slug,
    schoolName: school.name,
    email: school.email,
    countryId: school.country_id,
    defaultCurrencyId: school.default_currency_id,
    adminUserId,
    adminEmail,
  };
}

/**
 * Resend the email verification token for a school.
 *
 * Idempotent: returns the same response whether the school exists or not,
 * preventing email enumeration. Rate-limited by the route layer.
 *
 * Generates a new 256-bit token, stores its hash on the school, and emits
 * a verification email event. The old token is invalidated.
 */
export async function resendVerificationEmail(
  database: Database,
  params: { email: string },
  logger: Logger,
  options: { now?: () => number } = {},
): Promise<ResendVerificationResult> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const now = options.now?.() ?? Date.now();
  const expiresAt = new Date(now + VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000);

  // Find an unverified school with this email.
  const rows = await database<
    {
      id: string;
      email: string;
    }[]
  >`
    SELECT id, email
    FROM app.schools
    WHERE normalized_email = ${normalizedEmail}
      AND email_verified_at IS NULL
    LIMIT 1
  `;

  // Return the same response regardless — prevent enumeration.
  if (rows.length === 0) {
    logger.info(
      { email: normalizedEmail },
      "resend verification: school not found or already verified",
    );
    return { email: params.email };
  }

  const school = rows[0];
  const token = generateToken();
  const tokenHash = hashToken(token);

  await database.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;

    await tx`
      UPDATE app.schools
      SET email_verification_token_hash = ${tokenHash}::bytea,
          email_verification_expires_at = ${expiresAt.toISOString()}::timestamptz,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${school.id}::uuid
        AND email_verified_at IS NULL
    `;

    // Audit: verification token regenerated.
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "schools",
      targetId: school.id,
      newValues: {
        email_verification_token_hash: "[REDACTED]",
        email_verification_expires_at: expiresAt.toISOString(),
      },
    });

    // Domain event.
    await emit(tx, DOMAIN_EVENTS.SCHOOL_VERIFICATION_EMAIL_SENT, {
      schoolId: school.id,
      email: school.email,
      expiresAt: expiresAt.toISOString(),
    });

    logger.info({ school_id: school.id, email: school.email }, "verification email resent");
  });

  return { email: params.email };
}
