import { z } from "@hono/zod-openapi";
import { NOTIFICATION_TYPES } from "@studafy/constants";
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
