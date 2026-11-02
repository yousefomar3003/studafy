import { z } from "@hono/zod-openapi";

/**
 * Contracts for school sign-up applications.
 *
 * The applicant-facing bodies (`/api/school-applications/me*`) are snake_case like the other
 * pre-signup public bodies (`/api/inquiries`, `/api/schools/register`); the platform console's view
 * of the same rows is camelCase like the rest of `/api/platform/*`.
 */

export const APPLICATION_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Accepted proof-of-ownership types: a scan/photo of a licence, registration or deed. */
export const PROOF_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const PROOF_MAX_SIZE_BYTES = 10 * 1024 * 1024;

const isoDateTime = z.string().datetime();

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

export const applicationStatusSchema = z
  .enum(APPLICATION_STATUSES)
  .openapi("SchoolApplicationStatus");

// ---------------------------------------------------------------------------
// Applicant
// ---------------------------------------------------------------------------

export const applicantApplicationSchema = z
  .object({
    id: z.string().uuid(),
    status: applicationStatusSchema,
    school_name: z.string(),
    created_at: isoDateTime,
    reviewed_at: isoDateTime.nullable(),
    /** The reviewer's reason, shown to the applicant only when rejected. */
    review_note: z.string().nullable(),
  })
  .openapi("ApplicantSchoolApplication");

export const applicantMeResponseSchema = z
  .object({
    applicant: z.object({
      email: z.string(),
      name: z.string().nullable(),
      provider: z.enum(["google", "microsoft", "mock"]),
    }),
    /** The applicant's most recent application, or null before they submit one. */
    application: applicantApplicationSchema.nullable(),
  })
  .openapi("ApplicantMe");

export const proofUploadBodySchema = z
  .object({
    file_name: z.string().trim().min(1).max(255).openapi({ example: "license.pdf" }),
    content_type: z.enum(PROOF_CONTENT_TYPES),
    size_bytes: z.number().int().min(1).max(PROOF_MAX_SIZE_BYTES),
  })
  .openapi("SchoolApplicationProofUpload");

export const proofUploadResponseSchema = z
  .object({
    upload_url: z.string().url(),
    storage_key: z.string(),
    expires_at: isoDateTime,
  })
  .openapi("SchoolApplicationProofUploadUrl");

export const submitApplicationBodySchema = z
  .object({
    applicant_name: z.string().trim().min(1).max(200).openapi({ example: "Sara Al-Ahmad" }),
    applicant_job_title: optionalText(120),
    applicant_phone: z.string().trim().min(5).max(50).openapi({ example: "+966 50 123 4567" }),
    school_name: z.string().trim().min(1).max(200).openapi({ example: "Al Noor International" }),
    school_email: z
      .string()
      .trim()
      .email()
      .max(320)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    country_id: z.string().uuid(),
    default_currency_id: z.string().uuid(),
    city: z.string().trim().min(1).max(120).openapi({ example: "Riyadh" }),
    address: z.string().trim().min(1).max(500),
    website: optionalText(300),
    student_count: z.number().int().min(0).max(1_000_000).optional(),
    message: optionalText(5000),
    proof_storage_key: z.string().min(1).max(600),
    proof_file_name: z.string().trim().min(1).max(255),
  })
  .openapi("SubmitSchoolApplication");

// ---------------------------------------------------------------------------
// Platform console
// ---------------------------------------------------------------------------

export const platformApplicationSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: applicationStatusSchema,
    schoolName: z.string(),
    applicantName: z.string(),
    applicantEmail: z.string(),
    provider: z.string(),
    countryName: z.string(),
    city: z.string(),
    createdAt: isoDateTime,
    reviewedAt: isoDateTime.nullable(),
  })
  .openapi("PlatformSchoolApplicationSummary");

export const platformApplicationSchema = platformApplicationSummarySchema
  .extend({
    applicantJobTitle: z.string().nullable(),
    applicantPhone: z.string(),
    schoolEmail: z.string().nullable(),
    countryId: z.string().uuid(),
    countryCode: z.string(),
    currencyId: z.string().uuid(),
    currencyCode: z.string(),
    address: z.string(),
    website: z.string().nullable(),
    studentCount: z.number().int().nullable(),
    message: z.string().nullable(),
    proof: z.object({
      fileName: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      /** Short-lived pre-signed GET; null when object storage is not configured. */
      url: z.string().url().nullable(),
    }),
    reviewNote: z.string().nullable(),
    reviewedByUserId: z.string().uuid().nullable(),
    /** The school created on approval. */
    schoolId: z.string().uuid().nullable(),
    teamNotifiedAt: isoDateTime.nullable(),
    applicantNotifiedAt: isoDateTime.nullable(),
    updatedAt: isoDateTime,
  })
  .openapi("PlatformSchoolApplication");

export const applicationListQuerySchema = z.object({
  status: applicationStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const applicationListResponseSchema = z
  .object({
    applications: z.array(platformApplicationSummarySchema),
    total: z.number().int().nonnegative(),
    /** Unfiltered count of applications awaiting review, for the console's badge. */
    pendingCount: z.number().int().nonnegative(),
  })
  .openapi("PlatformSchoolApplicationList");

export const applicationIdParamSchema = z.object({ applicationId: z.string().uuid() });

export const approveApplicationBodySchema = z
  .object({ note: z.string().trim().max(2000).optional() })
  .openapi("ApprovePlatformSchoolApplication");

export const rejectApplicationBodySchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .openapi("RejectPlatformSchoolApplication");
