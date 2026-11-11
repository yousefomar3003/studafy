/**
 * Malware scanning of user uploads other than study materials (security finding F-14).
 *
 * Every upload another person can download is scanned by the workers' file-scan queue before it is
 * served. Materials keep their own lifecycle (app.materials.ingest_status); every other upload
 * carries an `app.upload_scan_status` column (000192) and is named here by its target, which the API
 * puts on the `scan-upload` job and the worker resolves to the table and columns it updates.
 */

/** The uploads the `scan-upload` job covers. Adding one needs a status column and a worker entry. */
export const UPLOAD_SCAN_TARGETS = [
  "submission_attachment",
  "assignment_attachment",
  "question_image",
  "message_attachment",
  "record_document",
  "expense_attachment",
  "license_receipt",
  "school_application_proof",
  "import_source",
] as const;

export type UploadScanTarget = (typeof UPLOAD_SCAN_TARGETS)[number];

/** Mirrors the app.upload_scan_status enum (000192). */
export const UPLOAD_SCAN_STATUSES = [
  // Uploaded before scanning covered this kind of file (000192). Served; a backfill scan may still
  // reach it.
  "unscanned",
  // Waiting for its scan. Not served.
  "scanning",
  // Scanned, nothing found. Served.
  "clean",
  // Infected: copied to quarantine/, the served copy deleted. Never served.
  "quarantined",
  // The scan could not complete after every retry. Never served (fail closed).
  "failed",
] as const;

export type UploadScanStatus = (typeof UPLOAD_SCAN_STATUSES)[number];

/** The statuses a download may be issued for. Everything else is refused as if the file were absent. */
export const SERVABLE_UPLOAD_SCAN_STATUSES: readonly UploadScanStatus[] = ["clean", "unscanned"];

export function isServableUploadScanStatus(status: string | null | undefined): boolean {
  return status === "clean" || status === "unscanned";
}
