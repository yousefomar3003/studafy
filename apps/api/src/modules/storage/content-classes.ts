/**
 * Content classes: the single source of truth for "what may be uploaded and downloaded, and by
 * whom".
 *
 * Each upload class pairs a policy (allowed MIME types + maximum size, both checked against the
 * object that actually lands in the bucket, not the request body) with the permission a caller
 * must hold to use it. The permission is what makes the storage gateway RBAC-aware without a
 * static mount-time guard: the required permission depends on the body, so it is asserted per
 * request via requirePermissionIn() rather than requirePermission() middleware.
 *
 * Enforcement model (docs/runbooks/storage-conventions.md):
 *   - request-upload rejects a class-invalid type or oversize claim before signing anything, and
 *     signs a PUT bound to the approved content type, so an attacker cannot smuggle a different
 *     file onto the signed URL.
 *   - confirm re-checks the *stored* object's type and size against the class before promoting it
 *     from temp/ to permanent/, closing the "claim small, upload big" gap.
 *   - a caller can only confirm under classes their roles permit, and only into their own school's
 *     prefix (assertSchoolOwnedKey), which is the tenant boundary on the return leg.
 *
 * The download classes below are the read leg of the same gateway. They pair a read permission
 * with an audit flag; the row-scope check that keeps a student out of another class's material is
 * the tenant-scoped resolver in download-service.ts running under RLS, not a static list here.
 */

import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { Permission } from "@studafy/constants";

export interface ContentClass {
  /** MIME types this class accepts, matching the Content-Type bound to the pre-signed PUT. */
  readonly allowedContentTypes: ReadonlySet<string>;
  /** Hard ceiling; enforced at request-upload and again against the stored object at confirm. */
  readonly maxSizeBytes: number;
  /** Permission required to request and confirm an upload of this class. */
  readonly requiredPermission: Permission;
}

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * Initial registry. These are deliberate, conservative defaults drawn from the existing
 * per-module upload flows (ST-103 assignments, ST-104 submissions, materials, finance expenses);
 * tightening a class is a one-line change that applies to every consumer at once.
 */
const CONTENT_CLASSES: ReadonlyMap<string, ContentClass> = new Map([
  [
    "assignment.attachment",
    {
      allowedContentTypes: new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "image/jpeg",
        "image/png",
      ]),
      maxSizeBytes: 25 * MIB,
      requiredPermission: PERMISSIONS.ASSIGNMENT_UPDATE,
    },
  ],
  [
    "submission.attachment",
    {
      allowedContentTypes: new Set([
        "application/pdf",
        "application/zip",
        "image/jpeg",
        "image/png",
      ]),
      maxSizeBytes: 25 * MIB,
      requiredPermission: PERMISSIONS.SUBMISSION_CREATE,
    },
  ],
  [
    "material.file",
    {
      allowedContentTypes: new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
        "text/markdown",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "video/mp4",
        "audio/mpeg",
      ]),
      maxSizeBytes: 100 * MIB,
      requiredPermission: PERMISSIONS.MATERIAL_CREATE,
    },
  ],
  [
    "expense.attachment",
    {
      allowedContentTypes: new Set(["application/pdf", "image/jpeg", "image/png"]),
      maxSizeBytes: 10 * MIB,
      requiredPermission: PERMISSIONS.BILLING_UPDATE,
    },
  ],
  [
    "user.avatar",
    {
      allowedContentTypes: new Set(["image/jpeg", "image/png", "image/webp"]),
      maxSizeBytes: 2 * MIB,
      requiredPermission: PERMISSIONS.USER_UPDATE,
    },
  ],
]);

export const CONTENT_CLASS_KEYS = [...CONTENT_CLASSES.keys()] as const;
export type ContentClassKey = (typeof CONTENT_CLASS_KEYS)[number];

/**
 * Resolve a content class from a client-supplied key, or reject the request.
 *
 * Unknown classes are a client error (typo, or a feature not enabled on this deployment), not a
 * security condition, so they answer 400 VALIDATION_FAILED rather than 403.
 */
export function getContentClass(key: string): ContentClass {
  const contentClass = CONTENT_CLASSES.get(key);
  if (!contentClass) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Unknown content class: ${key}`,
    );
  }
  return contentClass;
}

// ---------------------------------------------------------------------------
// Download classes
// ---------------------------------------------------------------------------

/**
 * A download class: what a caller needs to be able to hold before the gateway will mint a GET URL
 * for an object of this class.
 *
 * Row scope is deliberately not a field here. Each class resolves its object through a
 * tenant-scoped query that runs under RLS (download-service.ts), so a caller can only ever resolve
 * rows their roles can read; the resolver is the row-scope check, and this registry is only the
 * RBAC + audit policy layered on top of it.
 */
export interface DownloadClass {
  /**
   * Any one of these grants access. Most classes need exactly one; export is the union of the two
   * export-job tables (attendance and finance), so it lists both and either suffices.
   */
  readonly requiredPermissions: readonly Permission[];
  /**
   * Whether issuing a URL is written to app.audit_logs. Materials and submissions are ordinary
   * coursework and stay off the log like their uploads do; receipts and exports are finance-
   * adjacent, so their issuance is audited with the "export" action.
   */
  readonly audit: boolean;
}

/**
 * The download classes the gateway serves. Exactly the four the upload flow feeds: coursework
 * files (materials, submissions), finance evidence (receipts), and generated report files
 * (exports). Keys are single words on purpose: a download class is a read of an existing object,
 * not a sibling of the dotted upload classes, and reusing a dotted key would blur which leg a
 * caller meant.
 */
const DOWNLOAD_CLASSES: ReadonlyMap<string, DownloadClass> = new Map([
  ["material", { requiredPermissions: [PERMISSIONS.MATERIAL_READ], audit: false }],
  ["submission", { requiredPermissions: [PERMISSIONS.SUBMISSION_READ], audit: false }],
  ["receipt", { requiredPermissions: [PERMISSIONS.BILLING_READ], audit: true }],
  [
    "export",
    {
      requiredPermissions: [PERMISSIONS.ATTENDANCE_REPORT_EXPORT, PERMISSIONS.REPORT_EXPORT],
      audit: true,
    },
  ],
]);

export const DOWNLOAD_CLASS_KEYS = [...DOWNLOAD_CLASSES.keys()] as const;
export type DownloadClassKey = (typeof DOWNLOAD_CLASS_KEYS)[number];

/**
 * Resolve a download class from a client-supplied key, or reject the request. Unknown classes are
 * a client error (typo, or a feature not enabled on this deployment), not a security condition, so
 * they answer 400 VALIDATION_FAILED rather than 403 — the same call the upload leg makes.
 */
export function getDownloadClass(key: string): DownloadClass {
  const downloadClass = DOWNLOAD_CLASSES.get(key);
  if (!downloadClass) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Unknown download class: ${key}`,
    );
  }
  return downloadClass;
}
