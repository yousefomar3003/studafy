import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { sanitizedTextSchema } from "../../lib/sanitize";

/**
 * Mirrors ck_messages_body (000134): at most 2000 characters after trimming and sanitizing. A body
 * may be empty only when the message carries at least one image (enforced by sendMessageBodySchema).
 */
export const MESSAGE_BODY_MAX_LENGTH = 2000;

/** Mirrors ck_message_attachments_position (000134): at most four images per message. */
export const MESSAGE_ATTACHMENT_MAX_COUNT = 4;

/** Mirrors ck_message_attachments_mime_type (000134) and the `message.attachment` content class. */
export const MESSAGE_ATTACHMENT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;
export type MessageAttachmentContentType = (typeof MESSAGE_ATTACHMENT_CONTENT_TYPES)[number];

/** The storage content class a client stages message images under. */
export const MESSAGE_ATTACHMENT_CONTENT_CLASS = "message.attachment";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Mirrors app.parent_relationship (000008). */
export const PARENT_RELATIONSHIPS = [
  "mother",
  "father",
  "guardian",
  "step_parent",
  "grandparent",
  "sibling",
  "other",
] as const;
export type ParentRelationship = (typeof PARENT_RELATIONSHIPS)[number];

export const DEFAULT_MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const personSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
  })
  .openapi("MessagingPerson");

export const messageAttachmentSchema = z
  .object({
    id: uuidSchema,
    content_type: z.enum(MESSAGE_ATTACHMENT_CONTENT_TYPES),
    size_bytes: z.number().int().positive(),
    // The storage key itself is never serialized; the pre-signed URL is the only handle.
    download_url: z
      .string()
      .nullable()
      .openapi({
        description:
          "Short-lived (5 minute) pre-signed GET URL for the image. Null when object storage is not " +
          "configured for this deployment. Treat it as opaque and re-fetch the message list for a " +
          "fresh one after `download_url_expires_at`.",
      }),
    download_url_expires_at: dateTimeSchema.nullable().openapi({
      description: "When `download_url` stops working.",
    }),
  })
  .openapi("MessageAttachment");

export const messageSchema = z
  .object({
    id: uuidSchema,
    conversation_id: uuidSchema,
    sender_id: uuidSchema.openapi({ description: "The sending user's id." }),
    body: z.string().openapi({
      description: 'The text. Empty ("") for an image-only message.',
    }),
    attachments: z.array(messageAttachmentSchema).openapi({
      description: "Attached images in display order (0-4). Empty for a text-only message.",
    }),
    created_at: dateTimeSchema,
  })
  .openapi("Message");

export const blockStateSchema = z
  .object({
    blocked_by_me: z.boolean().openapi({
      description: "The caller has blocked the other participant.",
    }),
    has_blocked_me: z.boolean().openapi({
      description: "The other participant has blocked the caller.",
    }),
  })
  .openapi("MessagingBlockState");

export const conversationSchema = z
  .object({
    id: uuidSchema,
    student: personSchema.openapi({ description: "The child the thread is about (a student id)." }),
    parent: personSchema.openapi({ description: "The parent participant (a user id)." }),
    teacher: personSchema.openapi({ description: "The teacher participant (a user id)." }),
    last_message: z
      .object({
        body: z.string().openapi({ description: 'Empty ("") for an image-only message.' }),
        attachment_count: z.number().int().min(0).max(MESSAGE_ATTACHMENT_MAX_COUNT).openapi({
          description: 'Images on the newest message; show e.g. "Photo" when the body is empty.',
        }),
        sender_id: uuidSchema,
        created_at: dateTimeSchema,
      })
      .nullable()
      .openapi({ description: "The newest message, or null before anything has been sent." }),
    unread_count: z.number().int().min(0).openapi({
      description: "Messages from the other participant newer than the caller's read marker.",
    }),
    updated_at: dateTimeSchema.openapi({
      description: "Last activity: the newest message's time, or the thread's creation time.",
    }),
    blocked_by_me: z.boolean().openapi({
      description:
        "The caller has blocked the other participant. While either flag is true, sending fails " +
        "with 403 MESSAGING_BLOCKED; the history stays readable.",
    }),
    has_blocked_me: z.boolean().openapi({
      description: "The other participant has blocked the caller.",
    }),
  })
  .openapi("Conversation");

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const contactClassSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    course_name: z.string().nullable(),
  })
  .openapi("MessagingContactClass");

export const contactListSchema = z
  .object({
    contacts: z.array(
      z
        .object({
          teacher_id: uuidSchema.openapi({ description: "The teacher's user id." }),
          name: z.string(),
          classes: z.array(contactClassSchema),
          conversation_id: uuidSchema.nullable().openapi({
            description: "The existing thread with this teacher about this child, if any.",
          }),
        })
        .openapi("MessagingContact"),
    ),
  })
  .openapi("MessagingContactList");

export const teacherContactListSchema = z
  .object({
    students: z.array(
      z
        .object({
          id: uuidSchema.openapi({ description: "The student's id." }),
          name: z.string(),
          classes: z.array(contactClassSchema).openapi({
            description: "The caller's classes this student is currently enrolled in.",
          }),
          parents: z.array(
            z
              .object({
                parent_id: uuidSchema.openapi({ description: "The parent's user id." }),
                name: z.string(),
                relationship: z.enum(PARENT_RELATIONSHIPS).openapi({
                  description:
                    "How the parent is related to the student (app.parent_relationship).",
                }),
                conversation_id: uuidSchema.nullable().openapi({
                  description: "The existing thread with this parent about this student, if any.",
                }),
              })
              .openapi("TeacherMessagingParentContact"),
          ),
        })
        .openapi("TeacherMessagingStudentContact"),
    ),
  })
  .openapi("TeacherMessagingContactList");

export const conversationListSchema = z
  .object({ conversations: z.array(conversationSchema) })
  .openapi("ConversationList");

export const conversationEnvelopeSchema = z
  .object({ conversation: conversationSchema })
  .openapi("ConversationEnvelope");

export const messageListSchema = z
  .object({
    messages: z.array(messageSchema).openapi({ description: "Oldest first." }),
    has_more: z.boolean().openapi({
      description:
        "With `since`: more newer messages exist past this page. Otherwise: older messages exist " +
        "before this page (fetch them with `before` = the first message's id).",
    }),
  })
  .openapi("MessageList");

export const messageEnvelopeSchema = z
  .object({ message: messageSchema })
  .openapi("MessageEnvelope");

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const contactsQuerySchema = z.object({
  student_id: uuidSchema.openapi({ description: "A child linked to the calling parent." }),
});

export const conversationListQuerySchema = z.object({
  student_id: uuidSchema
    .optional()
    .openapi({ description: "Only threads about this child (meaningful for parents)." }),
});

export const createConversationBodySchema = z
  .object({
    student_id: uuidSchema,
    teacher_id: uuidSchema.openapi({ description: "The teacher's user id (from /contacts)." }),
  })
  .openapi("CreateConversationBody");

export const createTeacherConversationBodySchema = z
  .object({
    student_id: uuidSchema,
    parent_id: uuidSchema.openapi({
      description: "The parent's user id (from /teacher-contacts).",
    }),
  })
  .openapi("CreateTeacherConversationBody");

export const conversationIdParamSchema = z.object({ conversationId: uuidSchema });

export const messageListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_MESSAGE_PAGE_SIZE)
      .default(DEFAULT_MESSAGE_PAGE_SIZE),
    before: uuidSchema
      .optional()
      .openapi({ description: "Page older history: messages sent before this message id." }),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .openapi({ description: "Poll: messages created strictly after this ISO-8601 timestamp." }),
  })
  .refine((value) => value.before === undefined || value.since === undefined, {
    path: ["since"],
    message: "'before' and 'since' cannot be combined",
  });

export const sendMessageBodySchema = z
  .object({
    body: sanitizedTextSchema({ max: MESSAGE_BODY_MAX_LENGTH })
      .optional()
      .openapi({
        description:
          "The text, 0-2000 characters after trimming. Optional when `attachments` is non-empty; " +
          "a message needs a body or at least one image.",
      }),
    attachments: z
      .array(
        z
          .object({
            storage_key: z
              .string()
              .min(1)
              .max(1024)
              .openapi({
                description:
                  "The temp/ `storage_key` returned by POST /api/storage/uploads/request-upload " +
                  "(content_class `message.attachment`), after the client has PUT the image to its " +
                  "`upload_url`. Do NOT call /api/storage/uploads/confirm: the send confirms it.",
              }),
            checksum_sha256: z
              .string()
              .regex(
                SHA256_HEX,
                "checksum_sha256 must be a 64-character lowercase hex SHA-256 digest",
              )
              .optional()
              .openapi({ description: "Optional lowercase hex SHA-256 the server verifies." }),
          })
          .openapi("SendMessageAttachment"),
      )
      .max(MESSAGE_ATTACHMENT_MAX_COUNT)
      .optional()
      .openapi({ description: "Up to 4 staged images, in display order." }),
  })
  .refine((value) => (value.body ?? "").length > 0 || (value.attachments?.length ?? 0) > 0, {
    path: ["body"],
    message: "Message is required",
  })
  .refine(
    (value) =>
      new Set((value.attachments ?? []).map((a) => a.storage_key)).size ===
      (value.attachments ?? []).length,
    { path: ["attachments"], message: "Each attachment must be a different upload" },
  )
  .openapi("SendMessageBody");

export type SendMessageInput = z.infer<typeof sendMessageBodySchema>;

// ---------------------------------------------------------------------------
// Participant profile
// ---------------------------------------------------------------------------

const profileTeacherClassSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    course_name: z.string().nullable(),
    subject_name: z.string().nullable(),
  })
  .openapi("MessagingProfileTeacherClass");

export const participantProfileSchema = z
  .object({
    user_id: uuidSchema.openapi({ description: "The other participant's user id." }),
    name: z.string(),
    role: z.enum(["teacher", "parent"]).openapi({
      description: "The other participant's side of the thread.",
    }),
    blocked_by_me: z.boolean(),
    has_blocked_me: z.boolean(),
    classes: z.array(profileTeacherClassSchema).openapi({
      description:
        "role=teacher: the teacher's classes the thread's child is currently enrolled in. " +
        "Empty for role=parent.",
    }),
    subjects: z.array(z.string()).openapi({
      description:
        "role=teacher: distinct subject names across all the teacher's current classes. " +
        "Empty for role=parent.",
    }),
    relationship: z.enum(PARENT_RELATIONSHIPS).nullable().openapi({
      description:
        "role=parent: how the parent is related to the thread's child. Null for teachers.",
    }),
    children: z
      .array(
        z
          .object({
            id: uuidSchema.openapi({ description: "The student's id." }),
            name: z.string(),
            relationship: z.enum(PARENT_RELATIONSHIPS),
            is_conversation_student: z.boolean().openapi({
              description: "This is the child the thread is about.",
            }),
            classes: z.array(contactClassSchema).openapi({
              description: "The caller's classes this child is currently enrolled in.",
            }),
          })
          .openapi("MessagingProfileChild"),
      )
      .openapi({
        description:
          "role=parent: the parent's linked children whom the caller currently teaches, plus the " +
          "thread's own child. Other children are never listed. Empty for role=teacher.",
      }),
  })
  .openapi("MessagingParticipantProfile");

export const participantProfileEnvelopeSchema = z
  .object({ profile: participantProfileSchema })
  .openapi("MessagingParticipantProfileEnvelope");

export type ParticipantProfile = z.infer<typeof participantProfileSchema>;
export type BlockState = z.infer<typeof blockStateSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagingContactList = z.infer<typeof contactListSchema>;
export type TeacherMessagingContactList = z.infer<typeof teacherContactListSchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
