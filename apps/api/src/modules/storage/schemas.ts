import { z } from "@hono/zod-openapi";

import { CONTENT_CLASS_KEYS } from "./content-classes";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Request-upload body. file_name / content_type / size_bytes are *claims*: they gate what gets
 * signed, and the type and size are re-verified against the stored object at confirm.
 */
export const requestUploadBodySchema = z.object({
  content_class: z.enum(CONTENT_CLASS_KEYS).openapi({
    description:
      "Which policy governs this upload (allowed types, size limit, required permission).",
    example: "assignment.attachment",
  }),
  file_name: z.string().min(1).max(255).openapi({
    description:
      "Original file name. Must not contain / or \\, and must not be a traversal path — enforced again by the key builder.",
    example: "notes.pdf",
  }),
  content_type: z.string().min(1).openapi({
    description: "MIME type of the file. Must be in the content class's allowlist.",
    example: "application/pdf",
  }),
  size_bytes: z.number().int().positive().openapi({
    description: "Claimed size in bytes. Must not exceed the content class's maximum.",
    example: 2048,
  }),
});

export const uploadUrlResponseSchema = z.object({
  upload_url: z.string().url().openapi({
    description:
      "Short-lived pre-signed PUT URL. Bound to the storage_key, the content type, and its expiry — it cannot be replayed to another key or tenant.",
  }),
  storage_key: z.string().openapi({
    description: "The temp/ staging key for this upload. Return it unchanged on the confirm call.",
    example: "temp/school-123/uuid/notes.pdf",
  }),
  expires_at: z.string().datetime().openapi({
    description: "When the pre-signed URL stops being valid (ISO 8601).",
  }),
});

export const confirmUploadBodySchema = z.object({
  content_class: z.enum(CONTENT_CLASS_KEYS).openapi({
    description:
      "The same content class used at request-upload. Confirm re-checks permission, type, and size against it.",
  }),
  storage_key: z.string().min(1).openapi({
    description: "The storage_key returned by request-upload.",
    example: "temp/school-123/uuid/notes.pdf",
  }),
  checksum_sha256: z
    .string()
    .regex(SHA256_HEX, "checksum_sha256 must be a 64-character lowercase hex SHA-256 digest")
    .optional()
    .openapi({
      description:
        "Optional SHA-256 of the uploaded bytes. When supplied it is verified server-side against the stored object before promotion.",
      example: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }),
});

export const confirmedUploadSchema = z.object({
  storage_key: z.string().openapi({
    description:
      "The permanent/ key the object now lives at. Persist this — the temp/ key is reclaimed by the bucket's lifecycle rule.",
    example: "permanent/school-123/uuid/notes.pdf",
  }),
  original_file_name: z.string().openapi({
    description: "The file name segment of the storage key.",
    example: "notes.pdf",
  }),
  content_type: z.string().openapi({
    description: "The stored Content-Type, as S3 bound it at upload time.",
    example: "application/pdf",
  }),
  size_bytes: z.number().int().nonnegative().openapi({
    description: "The stored object's size, measured from the bucket.",
    example: 2048,
  }),
  checksum_sha256: z.string().nullable().openapi({
    description:
      "The server-computed SHA-256 when a checksum was supplied and verified, otherwise null.",
    example: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  }),
});
