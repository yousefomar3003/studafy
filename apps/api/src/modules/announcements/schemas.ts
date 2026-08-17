import { z } from "@hono/zod-openapi";
import { dateTimeSchema, paginationQuerySchema, uuidSchema } from "@studafy/shared-schemas";

import { roleSchema } from "../users/schemas";

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

export const announcementAudienceTypeSchema = z.enum(["school", "role", "class"]).openapi({
  description:
    "Who an announcement is addressed to: every active user in the school, everyone holding one " +
    "role, or everyone actively enrolled in one class.",
});

export const announcementStatusSchema = z.enum(["scheduled", "published"]).openapi({
  description:
    "'scheduled' means it has not been published yet (scheduled_at may be in the future or " +
    "briefly in the past while the sweep catches up); 'published' means recipients were resolved " +
    "and notified.",
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Mirrors ck_announcements_audience_shape (000105): exactly one of audience_role / audience_class_id
 * is present, matching audience_type. Validated again here so a bad request 400s with a field-level
 * message instead of surfacing as a raw constraint-violation 500.
 */
export const createAnnouncementBodySchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200),
    body: z.string().trim().min(1, "Message is required").max(5000),
    mandatory: z.boolean().openapi({
      description:
        "True sends as the platform's un-optoutable ADMIN_ANNOUNCEMENT type; false sends as " +
        "ANNOUNCEMENT, which a recipient may disable in their own notification preferences.",
    }),
    audience_type: announcementAudienceTypeSchema,
    audience_role: roleSchema.optional(),
    audience_class_id: uuidSchema.optional(),
    scheduled_at: dateTimeSchema.optional().openapi({
      description:
        "ISO-8601 instant to publish at. Omit, or pass an instant at or before now, to publish " +
        "immediately. A future instant schedules it for the workers' publish sweep instead.",
    }),
  })
  .superRefine((value, ctx) => {
    if (value.audience_type === "role" && value.audience_role === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["audience_role"],
        message: "audience_role is required when audience_type is 'role'",
      });
    }
    if (value.audience_type === "class" && value.audience_class_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["audience_class_id"],
        message: "audience_class_id is required when audience_type is 'class'",
      });
    }
    if (value.audience_type === "school") {
      if (value.audience_role !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["audience_role"],
          message: "audience_role must be omitted when audience_type is 'school'",
        });
      }
      if (value.audience_class_id !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["audience_class_id"],
          message: "audience_class_id must be omitted when audience_type is 'school'",
        });
      }
    }
  })
  .openapi("CreateAnnouncementBody");

export type CreateAnnouncementBody = z.infer<typeof createAnnouncementBodySchema>;

// ---------------------------------------------------------------------------
// Announcement (response)
// ---------------------------------------------------------------------------

export const announcementSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    created_by: uuidSchema,
    created_by_name: z.string().nullable().openapi({
      description: "The composing admin's display name at read time, joined for display.",
    }),
    title: z.string(),
    body: z.string(),
    mandatory: z.boolean(),
    audience_type: announcementAudienceTypeSchema,
    audience_role: roleSchema.nullable(),
    audience_class_id: uuidSchema.nullable(),
    audience_class_code: z.string().nullable().openapi({
      description:
        "The targeted class's code, joined for display. Null unless audience_type is 'class'.",
    }),
    status: announcementStatusSchema,
    scheduled_at: dateTimeSchema,
    published_at: dateTimeSchema.nullable(),
    recipient_count: z.number().int().nonnegative().openapi({
      description:
        "Size of the resolved audience at publish time. Zero until status is 'published'.",
    }),
    notified_count: z
      .number()
      .int()
      .nonnegative()
      .openapi({
        description:
          "Of recipient_count, how many actually received a notification — less than " +
          "recipient_count only for non-mandatory announcements some recipients had disabled.",
      }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Announcement");

export type Announcement = z.infer<typeof announcementSchema>;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const announcementListQuerySchema = paginationQuerySchema
  .extend({
    status: announcementStatusSchema.optional().openapi({
      description: "Restrict to one status. Omitted returns both.",
    }),
  })
  .openapi("AnnouncementListQuery");

export const announcementListSchema = z
  .object({
    items: z.array(announcementSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi("AnnouncementList");
