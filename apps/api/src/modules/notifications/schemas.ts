import { z } from "@hono/zod-openapi";
import { NOTIFICATION_TYPES } from "@studafy/constants";
import { NOTIFICATION_CHANNELS } from "@studafy/notification-templates";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

const notificationTypeValues = Object.values(NOTIFICATION_TYPES) as [string, ...string[]];

export const notificationTypeSchema = z
  .enum(notificationTypeValues)
  .openapi({ description: "Kind of notification, mirroring app.notification_type." });

export const notificationSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    user_id: uuidSchema.openapi({ description: "Recipient user. Always the authenticated user." }),
    notification_type: notificationTypeSchema,
    title: z.string().min(1).openapi({ description: "Headline text." }),
    body: z.string().min(1).openapi({ description: "Body text." }),
    metadata: z.record(z.string(), z.unknown()).openapi({
      description:
        "Deep-link payload carrying entity identifiers only, never a copy of the referenced entity's text.",
    }),
    read_at: dateTimeSchema.nullable().openapi({
      description: "When the recipient read this. Null means unread.",
    }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Notification");

export type Notification = z.infer<typeof notificationSchema>;

// ---------------------------------------------------------------------------
// List response
// ---------------------------------------------------------------------------

export const notificationListSchema = z
  .object({
    notifications: z.array(notificationSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("NotificationList");

// ---------------------------------------------------------------------------
// Unread count
// ---------------------------------------------------------------------------

export const unreadCountSchema = z
  .object({
    unread_count: z
      .number()
      .int()
      .nonnegative()
      .openapi({ description: "Number of unread notifications." }),
  })
  .openapi("UnreadCount");

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const notificationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    // An explicit enum rather than z.coerce.boolean(): Boolean("false") is true, so coercion would
    // silently turn ?unread_only=false into the unread-only view. The literal string is unambiguous.
    unread_only: z
      .enum(["true", "false"])
      .optional()
      .openapi({ description: "When true, return only unread notifications." }),
  })
  .openapi("NotificationListQuery");

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const notificationIdParamSchema = z
  .object({
    notificationId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "notificationId", in: "path" },
        description: "Notification UUID.",
      }),
  })
  .openapi("NotificationIdParam");

// ---------------------------------------------------------------------------
// Preferences (ST-143)
// ---------------------------------------------------------------------------

const notificationChannelValues = Object.values(NOTIFICATION_CHANNELS) as [string, ...string[]];

export const notificationChannelSchema = z
  .enum(notificationChannelValues)
  .openapi({ description: "Delivery channel, mirroring app.notification_channel." });

/** One (type, channel) cell of the authenticated user's preference matrix, as currently in effect. */
export const notificationPreferenceSchema = z
  .object({
    notification_type: notificationTypeSchema,
    channel: notificationChannelSchema,
    enabled: z.boolean().openapi({
      description: "Whether this type is delivered on this channel. Absent rows default to true.",
    }),
    digest: z.boolean().openapi({
      description:
        "When true, batched into the daily digest instead of sent immediately. Only settable on " +
        "the email channel for digest-eligible types — see digest_eligible.",
    }),
    mandatory: z.boolean().openapi({
      description:
        "When true, enabled cannot be set to false — the database rejects the write regardless of " +
        "caller.",
    }),
    digest_eligible: z.boolean().openapi({
      description: "Whether digest may be set to true for this (type, channel) pair.",
    }),
  })
  .openapi("NotificationPreference");

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

export const notificationPreferencesResponseSchema = z
  .object({
    preferences: z.array(notificationPreferenceSchema).openapi({
      description:
        "Every notification type crossed with every channel, seeded on activation and reflecting " +
        "any changes the user has since made.",
    }),
    attendance_alert_threshold: z
      .number()
      .int()
      .min(1)
      .max(365)
      .nullable()
      .openapi({
        description:
          "A parent's personal absence-count override, in addition to the school's own configured " +
          "threshold (app.attendance_alert_rules). Null means no personal override is set.",
      }),
  })
  .openapi("NotificationPreferences");

const notificationPreferenceUpdateSchema = z
  .object({
    notification_type: notificationTypeSchema,
    channel: notificationChannelSchema,
    enabled: z.boolean().optional(),
    digest: z.boolean().optional(),
  })
  .refine((value) => value.enabled !== undefined || value.digest !== undefined, {
    message: "At least one of enabled or digest must be provided.",
  })
  .openapi("NotificationPreferenceUpdate");

export const updateNotificationPreferencesRequestSchema = z
  .object({
    preferences: z
      .array(notificationPreferenceUpdateSchema)
      .min(1)
      .max(100)
      .optional()
      .openapi({ description: "(type, channel) cells to update. Unlisted cells are left as-is." }),
    attendance_alert_threshold: z.number().int().min(1).max(365).nullable().optional().openapi({
      description: "Set a personal attendance-alert threshold, or null to clear the override.",
    }),
  })
  .refine(
    (value) => value.preferences !== undefined || value.attendance_alert_threshold !== undefined,
    { message: "At least one of preferences or attendance_alert_threshold must be provided." },
  )
  .openapi("UpdateNotificationPreferencesRequest");

export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesRequestSchema
>;
