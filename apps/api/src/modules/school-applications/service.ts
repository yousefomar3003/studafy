/**
 * School sign-up applications.
 *
 * A prospective school owner signs in with Google or Microsoft (oauth-routes.ts), uploads a proof
 * of ownership and submits their school's details; the row lands in the global
 * `app.school_applications` table (studafy_admin only, migration 000139). Studafy staff review it in
 * the platform console. Approval creates the school -- already active, since a human has vetted it
 * -- with the applicant as its ORG_ADMIN, linked to the very (provider, subject) they applied with,
 * then provisions the tenant exactly as email verification does for self-registration.
 *
 * Emails are not sent from here. The worker's dispatcher notifies the onboarding inbox about each
 * new row and the applicant about each decision (apps/workers/.../school-applications.ts), driven
 * by the `*_notified_at` columns, so a failed send never rolls back a submission or a decision.
 *
 * ## Audit
 *
 * Global rows have no school of their own, so decisions are audited in the operator's home school
 * (the platform console convention -- see platform/service.ts). An approval additionally writes
 * system-attributed rows in the new school for what was created there.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { setTenantScope, withSystemTx } from "../../db/tenant-tx";
import { buildPermanentKey, buildTempKey, parseStorageKey } from "../../lib/storage/keys";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { findOAuthIdentity } from "../auth/services/returning-user-login-service";

import { PROOF_CONTENT_TYPES, PROOF_MAX_SIZE_BYTES } from "./schemas";

import type { ApplicantIdentity } from "./applicant-session";
import type { ApplicationStatus } from "./schemas";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { AuditEntry } from "../../middleware/auditEmitter";
import type { TransactionSql } from "postgres";

/** The reserved "school" segment for application proofs in the storage key scheme. */
export const APPLICATION_STORAGE_SEGMENT = "school-applications";

export interface Actor {
  userId: string;
  schoolId: string;
  requestId?: string;
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pg = error as { code?: string; constraint_name?: string };
  return pg.code === "23505" && (!constraint || pg.constraint_name === constraint);
}

function proofInvalid(message: string): CodedHttpException {
  return new CodedHttpException(400, ERROR_CODES.SCHOOL_APPLICATION_PROOF_INVALID, message);
}

/** Keeps a storage-key filename to a safe ASCII subset; the original name is stored separately. */
export function safeStorageFilename(fileName: string): string {
  const cleaned = fileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120);
  return cleaned || "proof";
}

// ---------------------------------------------------------------------------
// Applicant
// ---------------------------------------------------------------------------

interface ApplicantRow {
  id: string;
  status: ApplicationStatus;
  school_name: string;
  created_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
}

function toApplicantApplication(row: ApplicantRow) {
  return {
    id: row.id,
    status: row.status,
    school_name: row.school_name,
    created_at: iso(row.created_at),
    reviewed_at: isoOrNull(row.reviewed_at),
    review_note: row.status === "rejected" ? row.review_note : null,
  };
}

async function latestApplication(tx: TransactionSql, identity: ApplicantIdentity) {
  const [row] = await tx<ApplicantRow[]>`
    SELECT id, status, school_name, created_at, reviewed_at, review_note
    FROM app.school_applications
    WHERE provider = ${identity.provider} AND provider_subject = ${identity.subject}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

export async function getApplicantStatus(database: Database, identity: ApplicantIdentity) {
  const row = await withSystemTx(database, (tx) => latestApplication(tx, identity));
  return {
    applicant: { email: identity.email, name: identity.name, provider: identity.provider },
    application: row ? toApplicantApplication(row) : null,
  };
}

/**
 * A pre-signed PUT for the proof file, staged under `temp/school-applications/<uuid>/` -- the
 * bucket's 24h temp lifecycle cleans up anything never submitted. The object id is random, so a key
 * cannot be guessed and claimed by another applicant.
 */
export async function createProofUploadUrl(
  storage: StorageService,
  params: { fileName: string; contentType: string },
) {
  const key = buildTempKey(
    APPLICATION_STORAGE_SEGMENT,
    randomUUID(),
    safeStorageFilename(params.fileName),
  );
  const presigned = await storage.presign(key, "PUT", params.contentType);
  return {
    upload_url: presigned.url,
    storage_key: key,
    expires_at: iso(presigned.expiresAt),
  };
}

export interface SubmitApplicationParams {
  applicantName: string;
  applicantJobTitle?: string;
  applicantPhone: string;
  schoolName: string;
  schoolEmail?: string;
  countryId: string;
  defaultCurrencyId: string;
  city: string;
  address: string;
  website?: string;
  studentCount?: number;
  message?: string;
  proofStorageKey: string;
  proofFileName: string;
}

export async function submitApplication(
  database: Database,
  storage: StorageService,
  identity: ApplicantIdentity,
  params: SubmitApplicationParams,
) {
  // Cheap refusals first, before touching storage.
  const existing = await withSystemTx(database, (tx) => latestApplication(tx, identity));
  if (existing?.status === "pending") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SCHOOL_APPLICATION_ALREADY_PENDING,
      "You already have an application awaiting review.",
    );
  }
  if (await findOAuthIdentity(database, identity.provider, identity.subject)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SCHOOL_APPLICATION_ACCOUNT_EXISTS,
      "This account already belongs to a Studafy user. Sign in instead.",
    );
  }

  await assertReferenceData(database, params.countryId, params.defaultCurrencyId);

  // The proof: must be one of our staged keys, and what S3 actually stored must be acceptable --
  // the content type and size are read back from the bucket, never trusted from the client.
  const parsed = parseStorageKey(params.proofStorageKey);
  if (!parsed || parsed.category !== "temp" || parsed.schoolId !== APPLICATION_STORAGE_SEGMENT) {
    throw proofInvalid("Upload the proof of ownership before submitting.");
  }
  const head = await storage.head(params.proofStorageKey);
  if (!head) throw proofInvalid("The proof of ownership upload was not found. Upload it again.");
  if (!(PROOF_CONTENT_TYPES as readonly string[]).includes(head.contentType)) {
    throw proofInvalid("The proof of ownership must be a PDF or an image.");
  }
  if (head.sizeBytes <= 0 || head.sizeBytes > PROOF_MAX_SIZE_BYTES) {
    throw proofInvalid("The proof of ownership must be at most 10 MB.");
  }
  const permanentKey = buildPermanentKey(
    APPLICATION_STORAGE_SEGMENT,
    parsed.objectId,
    parsed.filename,
  );
  await storage.copy(params.proofStorageKey, permanentKey);

  try {
    const row = await withSystemTx(database, async (tx) => {
      const [inserted] = await tx<ApplicantRow[]>`
        INSERT INTO app.school_applications (
          provider, provider_subject, applicant_email, applicant_name, applicant_job_title,
          applicant_phone, school_name, school_email, country_id, default_currency_id, city,
          address, website, student_count, message, proof_storage_key, proof_file_name,
          proof_content_type, proof_size_bytes
        ) VALUES (
          ${identity.provider}, ${identity.subject}, ${identity.email}, ${params.applicantName},
          ${params.applicantJobTitle ?? null}, ${params.applicantPhone}, ${params.schoolName},
          ${params.schoolEmail?.toLowerCase() ?? null}, ${params.countryId}::uuid,
          ${params.defaultCurrencyId}::uuid, ${params.city}, ${params.address},
          ${params.website ?? null}, ${params.studentCount ?? null}, ${params.message ?? null},
          ${permanentKey}, ${params.proofFileName}, ${head.contentType}, ${head.sizeBytes}
        )
        RETURNING id, status, school_name, created_at, reviewed_at, review_note
      `;
      return inserted!;
    });
    return toApplicantApplication(row);
  } catch (error) {
    if (isUniqueViolation(error, "uq_school_applications_pending_identity")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SCHOOL_APPLICATION_ALREADY_PENDING,
        "You already have an application awaiting review.",
      );
    }
    throw error;
  }
}

async function assertReferenceData(
  database: Database,
  countryId: string,
  currencyId: string,
): Promise<void> {
  const [row] = await database<{ country_ok: boolean; currency_ok: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM app.countries WHERE id = ${countryId}::uuid AND is_active) AS country_ok,
      EXISTS (SELECT 1 FROM app.currencies WHERE id = ${currencyId}::uuid AND is_active)
        AS currency_ok
  `;
  if (!row?.country_ok || !row.currency_ok) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      row?.country_ok ? "Unknown currency." : "Unknown country.",
    );
  }
}

// ---------------------------------------------------------------------------
// Platform console
// ---------------------------------------------------------------------------

interface ApplicationRow {
  id: string;
  status: ApplicationStatus;
  provider: string;
  provider_subject: string;
  applicant_email: string;
  applicant_name: string;
  applicant_job_title: string | null;
  applicant_phone: string;
  school_name: string;
  school_email: string | null;
  country_id: string;
  country_name: string;
  country_code: string;
  default_currency_id: string;
  currency_code: string;
  city: string;
  address: string;
  website: string | null;
  student_count: number | null;
  message: string | null;
  proof_storage_key: string;
  proof_file_name: string;
  proof_content_type: string;
  proof_size_bytes: number;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  provisioned_school_id: string | null;
  team_notified_at: Date | null;
  applicant_notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const APPLICATION_SELECT = (tx: TransactionSql) => tx`
  SELECT a.id, a.status, a.provider, a.provider_subject, a.applicant_email, a.applicant_name,
         a.applicant_job_title, a.applicant_phone, a.school_name, a.school_email, a.country_id,
         co.name AS country_name, co.alpha2_code AS country_code, a.default_currency_id,
         cu.code AS currency_code, a.city, a.address, a.website, a.student_count, a.message,
         a.proof_storage_key, a.proof_file_name, a.proof_content_type, a.proof_size_bytes,
         a.reviewed_by_user_id, a.reviewed_at, a.review_note, a.provisioned_school_id,
         a.team_notified_at, a.applicant_notified_at, a.created_at, a.updated_at
  FROM app.school_applications a
  JOIN app.countries co ON co.id = a.country_id
  JOIN app.currencies cu ON cu.id = a.default_currency_id
`;

function toSummary(row: ApplicationRow) {
  return {
    id: row.id,
    status: row.status,
    schoolName: row.school_name,
    applicantName: row.applicant_name,
    applicantEmail: row.applicant_email,
    provider: row.provider,
    countryName: row.country_name,
    city: row.city,
    createdAt: iso(row.created_at),
    reviewedAt: isoOrNull(row.reviewed_at),
  };
}

async function toDetail(row: ApplicationRow, storage: StorageService | null) {
  const proofUrl = storage ? (await storage.presign(row.proof_storage_key, "GET")).url : null;
  return {
    ...toSummary(row),
    applicantJobTitle: row.applicant_job_title,
    applicantPhone: row.applicant_phone,
    schoolEmail: row.school_email,
    countryId: row.country_id,
    countryCode: row.country_code,
    currencyId: row.default_currency_id,
    currencyCode: row.currency_code,
    address: row.address,
    website: row.website,
    studentCount: row.student_count,
    message: row.message,
    proof: {
      fileName: row.proof_file_name,
      contentType: row.proof_content_type,
      sizeBytes: row.proof_size_bytes,
      url: proofUrl,
    },
    reviewNote: row.review_note,
    reviewedByUserId: row.reviewed_by_user_id,
    schoolId: row.provisioned_school_id,
    teamNotifiedAt: isoOrNull(row.team_notified_at),
    applicantNotifiedAt: isoOrNull(row.applicant_notified_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface ApplicationListFilters {
  status?: ApplicationStatus;
  search?: string;
  limit: number;
  offset: number;
}

export async function listApplications(database: Database, filters: ApplicationListFilters) {
  return withSystemTx(database, async (tx) => {
    const pattern = filters.search ? `%${filters.search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const where = tx`
      WHERE true
      ${filters.status ? tx`AND a.status = ${filters.status}` : tx``}
      ${
        pattern
          ? tx`AND (a.school_name ILIKE ${pattern} OR a.applicant_name ILIKE ${pattern}
                    OR a.applicant_email ILIKE ${pattern} OR a.city ILIKE ${pattern})`
          : tx``
      }
    `;
    const [{ total }] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.school_applications a ${where}
    `;
    const [{ pending_count }] = await tx<{ pending_count: number }[]>`
      SELECT count(*)::int AS pending_count FROM app.school_applications WHERE status = 'pending'
    `;
    const rows = await tx<ApplicationRow[]>`
      ${APPLICATION_SELECT(tx)} ${where}
      ORDER BY a.created_at DESC, a.id
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `;
    return {
      applications: rows.map(toSummary),
      total: total ?? 0,
      pendingCount: pending_count ?? 0,
    };
  });
}

async function loadApplication(tx: TransactionSql, applicationId: string, forUpdate = false) {
  const [row] = await tx<ApplicationRow[]>`
    ${APPLICATION_SELECT(tx)}
    WHERE a.id = ${applicationId}::uuid
    ${forUpdate ? tx`FOR UPDATE OF a` : tx``}
  `;
  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Application not found.");
  }
  return row;
}

export async function getApplication(
  database: Database,
  storage: StorageService | null,
  applicationId: string,
) {
  const row = await withSystemTx(database, (tx) => loadApplication(tx, applicationId));
  return toDetail(row, storage);
}

function assertPending(row: ApplicationRow): void {
  if (row.status !== "pending") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SCHOOL_APPLICATION_NOT_PENDING,
      "This application has already been reviewed.",
    );
  }
}

/** Writes one audit row under `schoolId`, attributed to `actorUserId` (or the system when null). */
async function auditIn(
  tx: TransactionSql,
  schoolId: string,
  actorUserId: string | null,
  entry: AuditEntry,
  requestId?: string,
): Promise<void> {
  await setTenantScope(tx, schoolId, requestId);
  await tx`SELECT set_config('app.user_id', ${actorUserId ?? ""}, true)`;
  await emitAuditLog(tx, entry);
}

/** URL-safe slug from the school name; non-Latin names fall back to "school". */
export function slugBase(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : base ? `${base}-school` : "school";
}

async function uniqueSlug(tx: TransactionSql, name: string): Promise<string> {
  const base = slugBase(name);
  const [taken] = await tx<{ taken: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM app.schools WHERE slug = ${base}) AS taken
  `;
  if (!taken?.taken) return base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${randomBytes(3).toString("hex")}`;
    const [row] = await tx<{ taken: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM app.schools WHERE slug = ${candidate}) AS taken
    `;
    if (!row?.taken) return candidate;
  }
  throw new CodedHttpException(
    409,
    ERROR_CODES.SCHOOL_SLUG_DUPLICATE,
    "Could not allocate a unique school slug.",
  );
}

export interface ApprovedSchool {
  schoolId: string;
  slug: string;
  schoolName: string;
  countryId: string;
  defaultCurrencyId: string;
  adminUserId: string;
  adminEmail: string;
}

/**
 * Approves a pending application: creates the school (active), its ORG_ADMIN linked to the
 * applicant's sign-in identity, and marks the application approved -- all in one transaction. The
 * caller provisions the tenant afterwards (trial subscription, ERPNext), which is idempotent and
 * retryable on its own, exactly as after self-registration's email verification.
 */
export async function approveApplication(
  database: Database,
  applicationId: string,
  note: string | undefined,
  actor: Actor,
): Promise<{ application: Awaited<ReturnType<typeof toDetail>>; school: ApprovedSchool }> {
  const { row, school } = await withSystemTx(database, async (tx) => {
    const before = await loadApplication(tx, applicationId, true);
    assertPending(before);

    const schoolEmail = before.school_email ?? before.applicant_email;
    const [emailTaken] = await tx<{ taken: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM app.schools WHERE normalized_email = ${schoolEmail.toLowerCase()}
      ) AS taken
    `;
    if (emailTaken?.taken) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SCHOOL_EMAIL_DUPLICATE,
        "A school with this email already exists.",
      );
    }

    const slug = await uniqueSlug(tx, before.school_name);
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (
        slug, name, email, normalized_email, status, country_id, default_currency_id,
        email_verified_at
      ) VALUES (
        ${slug}, ${before.school_name}, ${schoolEmail}, ${schoolEmail.toLowerCase()},
        'active'::app.school_status, ${before.country_id}::uuid,
        ${before.default_currency_id}::uuid, CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    const schoolId = created!.id;

    await tx`
      UPDATE app.school_applications SET
        status = 'approved',
        reviewed_by_user_id = ${actor.userId}::uuid,
        reviewed_at = CURRENT_TIMESTAMP,
        review_note = ${note || null},
        provisioned_school_id = ${schoolId}::uuid,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${applicationId}::uuid
    `;

    // Tenant-scoped inserts run as the runtime role under the new school's scope, exactly as
    // self-registration's do (tenancy/registration/service.ts).
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await setTenantScope(tx, schoolId, actor.requestId);
    await tx`SELECT set_config('app.user_id', '', true)`;

    await tx`INSERT INTO app.school_settings (school_id) VALUES (${schoolId}::uuid)`;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (
        school_id, email, normalized_email, display_name, status, email_verified_at
      ) VALUES (
        ${schoolId}::uuid, ${before.applicant_email}, ${before.applicant_email},
        ${before.applicant_name}, 'active'::app.user_status, CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    const adminUserId = user!.id;

    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}::uuid, ${adminUserId}::uuid, 'ORG_ADMIN'::app.user_role)
    `;

    let identityId: string;
    try {
      const [identity] = await tx<{ id: string }[]>`
        INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
        VALUES (${schoolId}::uuid, ${adminUserId}::uuid, ${before.provider},
                ${before.provider_subject})
        RETURNING id
      `;
      identityId = identity!.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.SCHOOL_APPLICATION_ACCOUNT_EXISTS,
          "The applicant's sign-in account already belongs to a Studafy user.",
        );
      }
      throw error;
    }

    // What Studafy created in the new school, system-attributed.
    const entries: AuditEntry[] = [
      {
        action: "insert",
        targetTable: "schools",
        targetId: schoolId,
        newValues: { slug, name: before.school_name, status: "active", application_id: before.id },
      },
      {
        action: "insert",
        targetTable: "users",
        targetId: adminUserId,
        newValues: { email: before.applicant_email, status: "active", role: "ORG_ADMIN" },
      },
      {
        action: "insert",
        targetTable: "oauth_identities",
        targetId: identityId,
        newValues: { provider: before.provider, user_id: adminUserId },
      },
    ];
    for (const entry of entries) await emitAuditLog(tx, entry);

    // Which staffer approved it, in their home school.
    await auditIn(
      tx,
      actor.schoolId,
      actor.userId,
      {
        action: "update",
        targetTable: "school_applications",
        targetId: applicationId,
        oldValues: { status: "pending" },
        newValues: { status: "approved", school_id: schoolId, review_note: note || null },
      },
      actor.requestId,
    );

    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const after = await loadApplication(tx, applicationId);
    return {
      row: after,
      school: {
        schoolId,
        slug,
        schoolName: before.school_name,
        countryId: before.country_id,
        defaultCurrencyId: before.default_currency_id,
        adminUserId,
        adminEmail: before.applicant_email,
      },
    };
  });

  return { application: await toDetail(row, null), school };
}

/** Rejects a pending application with a reason the applicant will see. */
export async function rejectApplication(
  database: Database,
  applicationId: string,
  reason: string,
  actor: Actor,
) {
  const row = await withSystemTx(database, async (tx) => {
    const before = await loadApplication(tx, applicationId, true);
    assertPending(before);

    await tx`
      UPDATE app.school_applications SET
        status = 'rejected',
        reviewed_by_user_id = ${actor.userId}::uuid,
        reviewed_at = CURRENT_TIMESTAMP,
        review_note = ${reason},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${applicationId}::uuid
    `;
    await auditIn(
      tx,
      actor.schoolId,
      actor.userId,
      {
        action: "update",
        targetTable: "school_applications",
        targetId: applicationId,
        oldValues: { status: "pending" },
        newValues: { status: "rejected", review_note: reason },
      },
      actor.requestId,
    );
    return loadApplication(tx, applicationId);
  });
  return toDetail(row, null);
}
