import { z } from "@hono/zod-openapi";

/**
 * Request/response contracts for manual grants (`/api/platform/.../grants`, 000211): storage caps and
 * feature tiers Studafy staff give a school or a person by hand, usually after a cash payment.
 * camelCase, like the rest of the platform console.
 */

export const GRANT_KINDS = ["storage", "tier"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** Where a grant is in its life, computed from its dates and revocation -- never stored. */
export const GRANT_STATES = ["scheduled", "active", "ended", "revoked"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

export const GRANT_LIST_FILTERS = ["active", "expiring", "ended", "all"] as const;
export type GrantListFilter = (typeof GRANT_LIST_FILTERS)[number];

/** The storage tiers the console offers as presets; any other positive cap is a custom grant. */
export const STORAGE_GRANT_PRESET_BYTES = {
  storage_100gb: 100 * 1024 * 1024 * 1024,
  storage_1tb: 1024 * 1024 * 1024 * 1024,
} as const;

/** 100 TiB: a ceiling against a typo, far above anything sold. */
export const MAX_GRANT_CAP_BYTES = 100 * 1024 * 1024 * 1024 * 1024;

const isoDateTime = z.string().datetime();
const reasonSchema = z.string().trim().min(1).max(1000);

export const grantIdParamSchema = z.object({
  schoolId: z
    .string()
    .uuid()
    .openapi({ param: { name: "schoolId", in: "path" } }),
  grantId: z
    .string()
    .uuid()
    .openapi({ param: { name: "grantId", in: "path" } }),
});

export const manualGrantSchema = z
  .object({
    id: z.string().uuid(),
    schoolId: z.string().uuid(),
    schoolName: z.string(),
    kind: z.enum(GRANT_KINDS),
    state: z.enum(GRANT_STATES),
    capBytes: z.number().int().nullable().openapi({ description: "Storage grants only." }),
    userId: z.string().uuid().nullable().openapi({ description: "Tier grants only." }),
    userName: z.string().nullable(),
    userEmail: z.string().nullable(),
    planCode: z.string().nullable().openapi({ description: "Tier grants only." }),
    planName: z.string().nullable(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    reason: z.string(),
    amountMinor: z.number().int().nullable(),
    currencyCode: z.string().nullable(),
    minorUnit: z.number().int().nullable(),
    hasReceipt: z.boolean(),
    grantedByUserId: z.string().uuid(),
    revokedAt: isoDateTime.nullable(),
    revokeReason: z.string().nullable(),
    createdAt: isoDateTime,
  })
  .openapi("PlatformManualGrant");

export const manualGrantListSchema = z
  .object({ grants: z.array(manualGrantSchema) })
  .openapi("PlatformManualGrantList");

export const grantListQuerySchema = z.object({
  filter: z.enum(GRANT_LIST_FILTERS).default("active").openapi({
    description:
      "active: in force now; expiring: in force and ending within 14 days; ended: ended or revoked.",
  }),
  kind: z.enum(GRANT_KINDS).optional(),
});

const paymentFields = {
  amountMinor: z.number().int().min(0).max(1_000_000_000_000).optional().openapi({
    description: "What was paid, in the currency's minor unit. Requires currencyCode.",
  }),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  receiptStorageKey: z.string().min(1).max(1024).optional().openapi({
    description:
      "A receipt file uploaded through POST /api/platform/schools/{schoolId}/license-payments/upload-url.",
  }),
};

export const createGrantBodySchema = z
  .object({
    kind: z.enum(GRANT_KINDS),
    capBytes: z.number().int().positive().max(MAX_GRANT_CAP_BYTES).optional().openapi({
      description: "Storage grants: the cap in bytes (100 GB and 1 TB are the sold tiers).",
    }),
    userId: z.string().uuid().optional().openapi({ description: "Tier grants: the person." }),
    planCode: z.string().min(1).max(100).optional().openapi({
      description: "Tier grants: the tier's plan code, of the person's own audience.",
    }),
    startsAt: isoDateTime.optional().openapi({ description: "Defaults to now." }),
    endsAt: isoDateTime,
    reason: reasonSchema,
    ...paymentFields,
  })
  .superRefine((body, ctx) => {
    if (body.kind === "storage" && body.capBytes === undefined) {
      ctx.addIssue({ code: "custom", path: ["capBytes"], message: "Required for a storage grant" });
    }
    if (body.kind === "tier" && (!body.userId || !body.planCode)) {
      ctx.addIssue({
        code: "custom",
        path: [body.userId ? "planCode" : "userId"],
        message: "Required for a tier grant",
      });
    }
    if ((body.amountMinor === undefined) !== (body.currencyCode === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["currencyCode"],
        message: "Give the amount and its currency together",
      });
    }
  })
  .openapi("PlatformCreateManualGrant");

export const revokeGrantBodySchema = z
  .object({ reason: reasonSchema })
  .openapi("PlatformRevokeManualGrant");

export const grantReceiptFileSchema = z
  .object({ url: z.string().url(), expiresAt: isoDateTime })
  .openapi("PlatformManualGrantReceiptFile");
