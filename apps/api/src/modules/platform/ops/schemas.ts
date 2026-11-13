import { z } from "@hono/zod-openapi";
import { FEATURE_FLAGS } from "@studafy/constants";

import { ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_SEVERITIES } from "./announcements-service";

/**
 * Contracts for the platform console's operations pages (`/api/platform/announcements`,
 * `/api/platform/activity`, `/api/platform/health`, `/api/platform/feature-flags`) and the banner
 * read every signed-in client makes (`/api/platform-banners`). camelCase, like the rest of the
 * platform console.
 */

const isoDateTime = z.string().datetime();
const FLAG_NAMES = Object.keys(FEATURE_FLAGS) as [keyof typeof FEATURE_FLAGS];

/** Why -- recorded in the audit row. A platform change is never anonymous. */
const reasonSchema = z.string().trim().min(3).max(500);

export const announcementAudienceSchema = z
  .enum(ANNOUNCEMENT_AUDIENCES)
  .openapi("PlatformAnnouncementAudience");
export const announcementSeveritySchema = z
  .enum(ANNOUNCEMENT_SEVERITIES)
  .openapi("PlatformAnnouncementSeverity");

const messageSchema = z.string().trim().min(1).max(500);

export const announcementSchema = z
  .object({
    id: z.string().uuid(),
    messageEn: z.string(),
    messageAr: z.string().nullable(),
    audience: announcementAudienceSchema,
    severity: announcementSeveritySchema,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    state: z.enum(["scheduled", "live", "ended"]),
    createdBy: z.string().uuid(),
    updatedBy: z.string().uuid(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .openapi("PlatformAnnouncement");

export const announcementListSchema = z
  .object({ announcements: z.array(announcementSchema) })
  .openapi("PlatformAnnouncementList");

export const announcementListQuerySchema = z.object({
  /** How many ended announcements to include after the live and scheduled ones. */
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createAnnouncementBodySchema = z
  .object({
    messageEn: messageSchema,
    messageAr: messageSchema.nullable().optional(),
    audience: announcementAudienceSchema.default("all"),
    severity: announcementSeveritySchema.default("info"),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    reason: reasonSchema,
  })
  .openapi("CreatePlatformAnnouncement");

export const updateAnnouncementBodySchema = z
  .object({
    messageEn: messageSchema.optional(),
    messageAr: messageSchema.nullable().optional(),
    audience: announcementAudienceSchema.optional(),
    severity: announcementSeveritySchema.optional(),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    /** Close the window now. Takes precedence over `endsAt`. */
    endNow: z.boolean().optional(),
    reason: reasonSchema,
  })
  .openapi("UpdatePlatformAnnouncement");

export const announcementIdParamSchema = z.object({
  announcementId: z
    .string()
    .uuid()
    .openapi({ param: { name: "announcementId", in: "path" } }),
});

export const activeBannerSchema = z
  .object({
    id: z.string().uuid(),
    messageEn: z.string(),
    messageAr: z.string().nullable(),
    severity: announcementSeveritySchema,
    /** False for maintenance banners, which stay until their window closes. */
    dismissible: z.boolean(),
    endsAt: isoDateTime,
  })
  .openapi("PlatformBanner");

export const activeBannerListSchema = z
  .object({ banners: z.array(activeBannerSchema) })
  .openapi("PlatformBannerList");

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export const activityQuerySchema = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  actorId: z.string().uuid().optional(),
  action: z
    .enum(["insert", "update", "delete", "login", "logout", "export", "permission_change", "read"])
    .optional(),
  targetTable: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .optional(),
  schoolId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(100).optional(),
});

const jsonObject = z.record(z.string(), z.unknown()).nullable();

export const activityEntrySchema = z
  .object({
    id: z.string().uuid(),
    createdAt: isoDateTime,
    actor: z.object({
      userId: z.string().uuid(),
      name: z.string().nullable(),
      email: z.string(),
      homeSchoolId: z.string().uuid(),
    }),
    action: z.string(),
    targetTable: z.string(),
    targetId: z.string().uuid(),
    /** The school the action changed; null for platform-wide tables or the operator's own school. */
    affectedSchool: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    reason: z.string().nullable(),
    oldValues: jsonObject,
    newValues: jsonObject,
    requestId: z.string().nullable(),
  })
  .openapi("PlatformActivityEntry");

export const activityListSchema = z
  .object({ entries: z.array(activityEntrySchema), nextCursor: z.string().nullable() })
  .openapi("PlatformActivityList");

export const platformOperatorListSchema = z
  .object({
    operators: z.array(
      z.object({
        userId: z.string().uuid(),
        name: z.string().nullable(),
        email: z.string(),
        roles: z.array(z.string()),
        homeSchoolId: z.string().uuid(),
        homeSchoolName: z.string(),
      }),
    ),
  })
  .openapi("PlatformOperatorList");

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

export const systemHealthSchema = z
  .object({
    generatedAt: isoDateTime,
    windowDays: z.number().int(),
    jobs: z.object({
      available: z.boolean(),
      queues: z.array(
        z.object({
          queue: z.string(),
          deadLetter: z.boolean(),
          waiting: z.number().int(),
          active: z.number().int(),
          delayed: z.number().int(),
          failed: z.number().int(),
          recentFailures: z.array(
            z.object({
              jobName: z.string(),
              failedAt: isoDateTime.nullable(),
              attempts: z.number().int(),
              reason: z.string().nullable(),
            }),
          ),
        }),
      ),
      scheduled: z.array(
        z.object({
          queue: z.string(),
          schedulerId: z.string(),
          jobName: z.string(),
          schedule: z.string().nullable(),
          nextRunAt: isoDateTime.nullable(),
          lastRun: z
            .object({
              at: isoDateTime,
              outcome: z.enum(["completed", "failed"]),
              error: z.string().nullable(),
            })
            .nullable(),
        }),
      ),
    }),
    notificationDeadLetters: z.object({
      total: z.number().int(),
      bySchool: z.array(
        z.object({
          schoolId: z.string().uuid(),
          schoolName: z.string(),
          count: z.number().int(),
          lastFailedAt: isoDateTime.nullable(),
        }),
      ),
    }),
    webhooks: z.object({
      failedEvents: z.array(z.object({ provider: z.string(), count: z.number().int() })),
      recentFailures: z.array(
        z.object({
          provider: z.string(),
          eventType: z.string(),
          status: z.string(),
          receivedAt: isoDateTime,
          attempts: z.number().int(),
          error: z.string().nullable(),
        }),
      ),
      rejectedSignatures: z.array(z.object({ type: z.string(), count: z.number().int() })),
    }),
    email: z.object({
      bounces: z.number().int(),
      complaints: z.number().int(),
      deliveries: z.number().int(),
    }),
    storage: z.object({
      available: z.boolean(),
      lastRunAt: isoDateTime.nullable(),
      totals: z
        .object({
          schools: z.number().int(),
          failed: z.number().int(),
          orphans: z.number().int(),
          orphanBytes: z.number(),
        })
        .nullable(),
      schools: z.array(
        z.object({
          schoolId: z.string(),
          schoolName: z.string(),
          bytesUsed: z.number(),
          orphans: z.number().int(),
          orphanBytes: z.number(),
          failed: z.boolean(),
        }),
      ),
    }),
    /** Signals the platform does not record, listed rather than guessed. */
    notAvailable: z.array(z.string()),
  })
  .openapi("PlatformSystemHealth");

// ---------------------------------------------------------------------------
// Feature flags across schools
// ---------------------------------------------------------------------------

export const flagOverviewListSchema = z
  .object({
    flags: z.array(
      z.object({
        name: z.enum(FLAG_NAMES),
        description: z.string(),
        registryDefault: z.boolean(),
        deploymentDefault: z.boolean(),
        overrides: z.array(
          z.object({
            schoolId: z.string().uuid(),
            schoolName: z.string(),
            schoolStatus: z.string(),
            enabled: z.boolean(),
          }),
        ),
        enabledSchools: z.number().int(),
        totalSchools: z.number().int(),
      }),
    ),
  })
  .openapi("PlatformFlagOverviewList");
