import { z } from "@hono/zod-openapi";
import { FEATURE_FLAGS, ROLES } from "@studafy/constants";

import { INQUIRY_STATUSES } from "../inquiries/schemas";

import type { Role } from "@studafy/constants";

/**
 * Request/response contracts for the Studafy platform console (`/api/platform/*`).
 *
 * Every shape here describes the platform as a whole -- many schools at once -- so none of them is
 * scoped to the caller's own tenant. camelCase throughout, matching the other platform-facing
 * endpoint (`GET /api/ai/admin/metrics`).
 */

export const SCHOOL_STATUSES = [
  "registered",
  "pending",
  "active",
  "suspended",
  "archived",
] as const;
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

const FLAG_NAMES = Object.keys(FEATURE_FLAGS) as [keyof typeof FEATURE_FLAGS];

export const schoolStatusSchema = z.enum(SCHOOL_STATUSES).openapi("PlatformSchoolStatus");

const isoDateTime = z.string().datetime();

export const schoolSubscriptionSchema = z
  .object({
    planCode: z.string(),
    planName: z.string(),
    // A string rather than an enum: app.subscription_status has grown by migration (grace_period,
    // closed, paused) and the console only displays it.
    status: z.string(),
    studentCap: z.number().int(),
    trialExpiresAt: isoDateTime.nullable(),
    currentPeriodEnd: isoDateTime,
  })
  .openapi("PlatformSchoolSubscription");

export const schoolSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    email: z.string(),
    status: schoolStatusSchema,
    /** Platform-assigned school number; the leading digits of the school's member codes. */
    schoolNumber: z.number().int().positive(),
    countryCode: z.string(),
    currencyCode: z.string(),
    isReviewTenant: z.boolean(),
    createdAt: isoDateTime,
    activeUsers: z.number().int().nonnegative(),
    students: z.number().int().nonnegative(),
    subscription: schoolSubscriptionSchema.nullable(),
  })
  .openapi("PlatformSchoolSummary");

export const schoolListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: schoolStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const schoolListResponseSchema = z
  .object({
    schools: z.array(schoolSummarySchema),
    total: z.number().int().nonnegative(),
  })
  .openapi("PlatformSchoolList");

export const featureFlagStateSchema = z
  .object({
    name: z.enum(FLAG_NAMES),
    description: z.string(),
    defaultValue: z.boolean(),
    /** The school's override row, or null when the school runs on the deployment default. */
    override: z.boolean().nullable(),
  })
  .openapi("PlatformFeatureFlagState");

export const schoolDetailSchema = schoolSummarySchema
  .extend({
    emailVerifiedAt: isoDateTime.nullable(),
    updatedAt: isoDateTime,
    roleCounts: z.record(z.string(), z.number().int().nonnegative()),
    featureFlags: z.array(featureFlagStateSchema),
    /** The lifecycle states this school may move to next, from the transition table. */
    allowedTransitions: z.array(schoolStatusSchema),
  })
  .openapi("PlatformSchoolDetail");

export const schoolIdParamSchema = z.object({
  schoolId: z
    .string()
    .uuid()
    .openapi({ param: { name: "schoolId", in: "path" } }),
});

export const updateSchoolStatusBodySchema = z
  .object({
    status: schoolStatusSchema,
    /** Why -- recorded in both audit rows. Required: a lifecycle change is never anonymous. */
    reason: z.string().trim().min(3).max(500),
  })
  .openapi("UpdatePlatformSchoolStatus");

export const updateSchoolStatusResponseSchema = z
  .object({
    school: schoolDetailSchema,
    /**
     * Students' AI subscriptions paused or resumed alongside the change. `null` when the change
     * does not touch AI billing or no payment provider is configured; `false` in `aiBillingSynced`
     * means the provider call failed after the status committed -- re-send the same status to retry.
     */
    aiSubscriptionsAffected: z.number().int().nonnegative().nullable(),
    aiBillingSynced: z.boolean(),
  })
  .openapi("UpdatePlatformSchoolStatusResult");

export const featureFlagParamSchema = z.object({
  schoolId: z
    .string()
    .uuid()
    .openapi({ param: { name: "schoolId", in: "path" } }),
  flagName: z.enum(FLAG_NAMES).openapi({ param: { name: "flagName", in: "path" } }),
});

export const setFeatureFlagBodySchema = z
  .object({
    /** true/false pins the school; null removes the override and falls back to the default. */
    enabled: z.boolean().nullable(),
  })
  .openapi("SetPlatformFeatureFlag");

export const overviewSchema = z
  .object({
    schoolsByStatus: z.record(schoolStatusSchema, z.number().int().nonnegative()),
    totalSchools: z.number().int().nonnegative(),
    newSchoolsLast30Days: z.number().int().nonnegative(),
    totalActiveUsers: z.number().int().nonnegative(),
    totalStudents: z.number().int().nonnegative(),
    subscriptionsByStatus: z.record(z.string(), z.number().int().nonnegative()),
    subscriptionsByPlan: z.record(z.string(), z.number().int().nonnegative()),
    trialsEndingIn7Days: z.number().int().nonnegative(),
    activeAiSubscriptions: z.number().int().nonnegative(),
    generatedAt: isoDateTime,
  })
  .openapi("PlatformOverview");

export const FINANCE_ATTENTION_REASONS = [
  "past_due",
  "grace_period",
  "paused",
  "cancel_scheduled",
  "trial_ending",
] as const;

const money = {
  currencyCode: z.string(),
  minorUnit: z.number().int().nonnegative(),
};

export const financeSchema = z
  .object({
    /** Estimated monthly recurring revenue at list price, one row per billing currency. */
    revenueByCurrency: z.array(
      z
        .object({
          ...money,
          estimatedMrrMinor: z.number().int().nonnegative(),
          billedSchools: z.number().int().nonnegative(),
        })
        .openapi("PlatformRevenueByCurrency"),
    ),
    /** Renewal charges attempted in the last 30 days, school plans and AI add-ons together. */
    renewalsLast30Days: z.array(
      z
        .object({
          ...money,
          collectedMinor: z.number().int().nonnegative(),
          succeeded: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
        })
        .openapi("PlatformRenewalTotals"),
    ),
    /** Schools whose billing needs a human: overdue, in grace, paused, cancelling, trial ending. */
    attention: z.array(
      z
        .object({
          schoolId: z.string().uuid(),
          schoolName: z.string(),
          reason: z.enum(FINANCE_ATTENTION_REASONS),
          subscriptionStatus: z.string(),
          planName: z.string(),
          dueAt: isoDateTime.nullable(),
        })
        .openapi("PlatformFinanceAttention"),
    ),
    recentFailedRenewals: z.array(
      z
        .object({
          id: z.string().uuid(),
          schoolId: z.string().uuid(),
          schoolName: z.string(),
          subscriptionType: z.enum(["school", "ai"]),
          attemptedAt: isoDateTime,
          amountMinor: z.number().int().nonnegative(),
          ...money,
          failureReason: z.string().nullable(),
        })
        .openapi("PlatformFailedRenewal"),
    ),
    generatedAt: isoDateTime,
  })
  .openapi("PlatformFinance");

export const planPriceSchema = z
  .object({
    id: z.string().uuid(),
    currencyCode: z.string(),
    billingInterval: z.string(),
    amountMinor: z.number().int().nonnegative(),
    minorUnit: z.number().int().nonnegative(),
    isActive: z.boolean(),
  })
  .openapi("PlatformPlanPrice");

export const planSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    displayName: z.string(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    prices: z.array(planPriceSchema),
    updatedAt: isoDateTime,
  })
  .openapi("PlatformPlan");

export const planListResponseSchema = z
  .object({ plans: z.array(planSchema) })
  .openapi("PlatformPlanList");

export const planIdParamSchema = z.object({
  planId: z
    .string()
    .uuid()
    .openapi({ param: { name: "planId", in: "path" } }),
});

export const updatePlanBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field" })
  .openapi("UpdatePlatformPlan");

export const planPriceParamSchema = z.object({
  planId: z
    .string()
    .uuid()
    .openapi({ param: { name: "planId", in: "path" } }),
  priceId: z
    .string()
    .uuid()
    .openapi({ param: { name: "priceId", in: "path" } }),
});

export const updatePlanPriceBodySchema = z
  .object({ isActive: z.boolean() })
  .openapi("UpdatePlatformPlanPrice");

export const platformSettingSchema = z
  .object({
    key: z.string(),
    description: z.string(),
    valueType: z.enum(["boolean", "integer", "text"]),
    value: z.union([z.boolean(), z.number().int(), z.string()]),
    sensitivity: z.enum(["public", "internal"]),
    isMutable: z.boolean(),
    requiresRestart: z.boolean(),
    updatedAt: isoDateTime,
  })
  .openapi("PlatformSetting");

export const platformSettingListSchema = z
  .object({ settings: z.array(platformSettingSchema) })
  .openapi("PlatformSettingList");

export const settingKeyParamSchema = z.object({
  key: z
    .string()
    // Character set only; the table's CHECK owns the exact dotted shape, and an unknown key is a 404.
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(100)
    .openapi({ param: { name: "key", in: "path" } }),
});

export const updatePlatformSettingBodySchema = z
  .object({ value: z.union([z.boolean(), z.number().int(), z.string().trim().min(1).max(2000)]) })
  .openapi("UpdatePlatformSetting");

export const userLookupQuerySchema = z.object({
  email: z.string().trim().email().max(320),
});

export const userLookupResultSchema = z
  .object({
    schoolId: z.string().uuid(),
    schoolName: z.string(),
    schoolStatus: schoolStatusSchema,
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    email: z.string(),
    status: z.string(),
    roles: z.array(z.string()),
    lastLoginAt: isoDateTime.nullable(),
  })
  .openapi("PlatformUserLookupResult");

export const userLookupResponseSchema = z
  .object({ matches: z.array(userLookupResultSchema) })
  .openapi("PlatformUserLookup");

/** `app.user_status`. */
export const MEMBER_STATUSES = ["invited", "active", "suspended", "archived"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

const ROLE_NAMES = Object.values(ROLES) as [Role, ...Role[]];

export const schoolMemberListQuerySchema = z.object({
  role: z.enum(ROLE_NAMES).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
  /** Name, email, student admission number or teacher employee number. */
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const schoolMemberSchema = z
  .object({
    userId: z.string().uuid(),
    /** The account's display name, falling back to the student record's legal name. */
    displayName: z.string().nullable(),
    /** Null for members who sign in with their member ID and a password. */
    email: z.string().nullable(),
    status: z.enum(MEMBER_STATUSES),
    roles: z.array(z.string()),
    /** Platform-issued IDs, one per student/teacher/parent role held: e.g. STU-100001. */
    memberCodes: z.array(z.string()),
    createdAt: isoDateTime,
    lastLoginAt: isoDateTime.nullable(),
    /** Present when the account has a student record. */
    student: z
      .object({
        studentId: z.string().uuid(),
        admissionNumber: z.string(),
        status: z.string(),
        /** Codes of the active classes the student is actively enrolled in. */
        classes: z.array(z.string()),
        guardians: z.array(
          z.object({
            userId: z.string().uuid(),
            displayName: z.string().nullable(),
            relationship: z.string(),
          }),
        ),
      })
      .nullable(),
    /** Present when the account has a teacher record. */
    teacher: z.object({ employeeNumber: z.string(), employmentStatus: z.string() }).nullable(),
    /** Students linked to this account as a parent/guardian; empty for everyone else. */
    children: z.array(
      z.object({
        studentId: z.string().uuid(),
        userId: z.string().uuid(),
        name: z.string(),
        admissionNumber: z.string(),
        relationship: z.string(),
      }),
    ),
  })
  .openapi("PlatformSchoolMember");

export const schoolMemberListResponseSchema = z
  .object({
    members: z.array(schoolMemberSchema),
    /** Members matching the filters. */
    total: z.number().int().nonnegative(),
    /** Every account in the school, unfiltered. */
    memberCount: z.number().int().nonnegative(),
    /** Unfiltered role assignments by role, for the filter chips. */
    roleCounts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .openapi("PlatformSchoolMemberList");

export const inquiryStatusSchema = z.enum(INQUIRY_STATUSES).openapi("PlatformInquiryStatus");

export const inquirySchema = z
  .object({
    id: z.string().uuid(),
    fullName: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    schoolName: z.string(),
    jobTitle: z.string().nullable(),
    country: z.string().nullable(),
    studentCount: z.number().int().nullable(),
    message: z.string().nullable(),
    sourcePath: z.string().nullable(),
    status: inquiryStatusSchema,
    internalNotes: z.string().nullable(),
    /** When the sales inbox was emailed about it; null while pending or after delivery gave up. */
    notifiedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .openapi("PlatformInquiry");

export const inquiryListQuerySchema = z.object({
  status: inquiryStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const inquiryListResponseSchema = z
  .object({
    inquiries: z.array(inquirySchema),
    total: z.number().int().nonnegative(),
    /** Unfiltered count of `new` inquiries, for the console's badge. */
    newCount: z.number().int().nonnegative(),
  })
  .openapi("PlatformInquiryList");

export const inquiryIdParamSchema = z.object({ inquiryId: z.string().uuid() });

export const updateInquiryBodySchema = z
  .object({
    status: inquiryStatusSchema.optional(),
    internalNotes: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((body) => body.status !== undefined || body.internalNotes !== undefined, {
    message: "Provide a status or internal notes to change.",
  })
  .openapi("UpdatePlatformInquiry");
