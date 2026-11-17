/**
 * Limits on a student's own AI sources (000232): the files and photos a student uploads to use with
 * the AI study tools.
 *
 * The bytes count on the school's storage meter like every other upload (they live under
 * permanent/<schoolId>/ai-sources/, a prefix the daily reconciliation already counts), so the
 * school's quota is the outer ceiling. These per-student caps sit inside it so one student cannot
 * fill the school's storage with study notes, and they keep hosting cheap: a source is only text to
 * the AI tools, and a phone photo the app has re-encoded is a few hundred KB.
 */

/** Largest file a student may upload as an AI source: a long PDF chapter fits, a video does not. */
export const AI_SOURCE_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** How many of their own sources a student may keep at once. */
export const AI_SOURCE_MAX_PER_STUDENT = 20;

/** The total bytes of one student's own sources. */
export const AI_SOURCE_MAX_BYTES_PER_STUDENT = 100 * 1024 * 1024;

/**
 * How long a student's own source is kept after it was uploaded; the workers' abandoned-material
 * sweep deletes it (and its file) after that. Mirrored in
 * apps/workers/src/queues/maintenance/abandoned-material-sweep.ts (PERSONAL_SOURCE_RETENTION_DAYS).
 */
export const AI_SOURCE_RETENTION_DAYS = 365;

/**
 * An unconfirmed upload younger than this still counts against the per-student caps: its PUT may
 * still be in flight. An older one is abandoned (the sweep removes it within a day) and is not
 * counted, so a failed upload never locks the student out.
 */
export const AI_SOURCE_PENDING_UPLOAD_GRACE_MINUTES = 60;

/**
 * The formats the ingestion pipeline reads (apps/workers/src/queues/ai-ingestion/parsers): PDF,
 * Word, PowerPoint, and JPEG / PNG photos, which are OCR'd. HEIC is not read by the OCR engine; the
 * app re-encodes a camera or gallery photo to JPEG before uploading it.
 */
export const AI_SOURCE_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
] as const;

export type AiSourceMimeType = (typeof AI_SOURCE_MIME_TYPES)[number];

export function isAiSourceMimeType(value: string): value is AiSourceMimeType {
  return (AI_SOURCE_MIME_TYPES as readonly string[]).includes(value);
}

/** The MIME type an assignment source is stored with; it has no file of its own. */
export const AI_ASSIGNMENT_SOURCE_MIME_TYPE = "application/vnd.studafy.assignment";

/** How many assignments the "My assignments" source list offers, most recent due date first. */
export const AI_ASSIGNMENT_SOURCE_LIST_LIMIT = 50;

/**
 * A queued assignment source left this long without an update is re-enqueued on the next request:
 * its job was lost (Redis down when it was queued). The ingestion worker's claim makes a duplicate
 * job a no-op, so this is safe.
 */
export const AI_ASSIGNMENT_SOURCE_REQUEUE_MINUTES = 5;
