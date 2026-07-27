/**
 * Object storage key scheme (ST-103).
 *
 * The layout is fixed by docs/runbooks/storage-conventions.md:
 *
 *   <category>/<schoolId>/<objectId>/<filename>
 *
 * Category comes FIRST, before the school. That ordering looks wrong -- tenant-leading is the rule
 * everywhere else in this system -- and the runbook explains why it is not: the `temp/` and
 * `reports/` lifecycle rules on the app-files bucket match a single literal S3 key prefix, with no
 * wildcard and no "any depth" option. `schools/<schoolId>/temp/...` would need one lifecycle rule
 * per school, and schools are created at runtime, not by a Terraform apply. Category-first is what
 * makes a fixed, small number of rules cover every tenant.
 *
 * This module is the application half of the tenant boundary on storage keys. The other half is
 * ck_assignment_attachments_storage_key in db/migrations/000047, which pins a persisted key to its
 * own row's school_id. Neither is sufficient alone: this one stops an object being written into or
 * read from another school's prefix, and the constraint stops a row claiming an object there.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

/** Top-level lifecycle categories on the app-files bucket. See the runbook's table. */
export type StorageCategory = "temp" | "reports" | "permanent";

const STORAGE_CATEGORIES: ReadonlySet<string> = new Set<StorageCategory>([
  "temp",
  "reports",
  "permanent",
]);

/** A key decomposed into its four segments. */
export interface ParsedStorageKey {
  category: StorageCategory;
  schoolId: string;
  objectId: string;
  filename: string;
}

/**
 * Whether a filename contains a character that must never reach a storage key.
 *
 * `/` and `\` would add key segments and break the four-segment scheme, which is exactly what
 * turns a filename into a path traversal. Control characters are rejected because they survive an
 * S3 round trip but render unpredictably in a Content-Disposition header.
 *
 * Written as a code-point scan rather than a regex character class: the class would have to embed
 * literal control characters or \u escapes, and both are easy to corrupt silently in a way that
 * widens what this accepts without any visible diff.
 */
function hasUnsafeFilenameChar(filename: string): boolean {
  for (const char of filename) {
    if (char === "/" || char === "\\") return true;
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/** A school id or object id: an opaque identifier with no separators. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename.length <= 255 &&
    !hasUnsafeFilenameChar(filename) &&
    // A filename that is "." or begins with ".." is a traversal attempt however the storage
    // backend happens to normalize it.
    filename !== "." &&
    !filename.startsWith("..")
  );
}

function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== "." && !segment.startsWith("..");
}

function buildKey(
  category: StorageCategory,
  schoolId: string,
  objectId: string,
  filename: string,
): string {
  if (!isSafeSegment(schoolId) || !isSafeSegment(objectId) || !isSafeFilename(filename)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Invalid object storage key segment",
    );
  }
  return `${category}/${schoolId}/${objectId}/${filename}`;
}

/**
 * Staging key for a pre-signed upload. Objects here age out after 24h if never confirmed -- that
 * expiry is the only thing that cleans up abandoned uploads, not a fallback for something else.
 */
export function buildTempKey(schoolId: string, objectId: string, filename: string): string {
  return buildKey("temp", schoolId, objectId, filename);
}

/** Key for confirmed, long-lived content. No expiration. */
export function buildPermanentKey(schoolId: string, objectId: string, filename: string): string {
  return buildKey("permanent", schoolId, objectId, filename);
}

/**
 * Decompose a key, or return null when it does not match the scheme.
 *
 * Returns null rather than throwing so callers can distinguish "malformed" from "well-formed but
 * belongs to someone else" -- those are different failures deserving different status codes.
 */
export function parseStorageKey(key: string): ParsedStorageKey | null {
  if (key !== key.trim() || key.length === 0) return null;

  const segments = key.split("/");
  if (segments.length !== 4) return null;

  const [category, schoolId, objectId, filename] = segments as [string, string, string, string];

  if (!STORAGE_CATEGORIES.has(category)) return null;
  if (!isSafeSegment(schoolId) || !isSafeSegment(objectId) || !isSafeFilename(filename))
    return null;

  return { category: category as StorageCategory, schoolId, objectId, filename };
}

/**
 * Assert that a client-supplied key is well-formed, sits under `expectedCategory`, and belongs to
 * `schoolId` -- then return it decomposed.
 *
 * This runs before any storage call and before any database write. The key arrives from the client
 * (it is handed back in the upload-url response), so it is untrusted input in the ordinary way, and
 * it is the only thing standing between a caller and another tenant's objects. Both failure modes
 * raise 403 rather than 404: a caller who may not touch a key should not be able to learn from the
 * status code whether it exists.
 */
export function assertSchoolOwnedKey(
  key: string,
  schoolId: string,
  expectedCategory: StorageCategory,
): ParsedStorageKey {
  const parsed = parseStorageKey(key);

  if (!parsed || parsed.category !== expectedCategory || parsed.schoolId !== schoolId) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.STORAGE_KEY_FORBIDDEN,
      "Storage key does not belong to this school",
    );
  }

  return parsed;
}
