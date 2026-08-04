/**
 * Storage service: the two-step pre-signed upload flow, content-class aware.
 *
 * Request-upload mints a signed PUT under temp/<schoolId>/<objectId>/<filename> -- the objectId is
 * generated here, so the key is always tenant-prefixed and can never collide across schools.
 * Confirm proves the object really exists, re-checks its stored type and size against the content
 * class (a request body is a claim; the bucket is the truth), optionally verifies the SHA-256 the
 * client computed, then promotes temp/ -> permanent/.
 *
 * This module is database-free by design: it is the storage half of the flow. Consumers persist the
 * returned permanent key on their own rows, and the DB constraint family from ST-103
 * (ck_*_storage_key) pins any persisted key to its own row's school_id -- the second half of the
 * tenant boundary.
 */

import { randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { assertSchoolOwnedKey, buildPermanentKey, buildTempKey } from "../../lib/storage/keys";
import { promoteTempObject } from "../../lib/storage/promote";

import type { ContentClass } from "./content-classes";
import type { PresignedUrl, StorageService } from "../../lib/storage";

export interface RequestUploadParams {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface RequestUploadResult {
  storageKey: string;
  presigned: PresignedUrl;
}

/**
 * Validate the caller's claims against the content class, then sign a PUT for a fresh temp key.
 *
 * The order is load-bearing: type and size are rejected BEFORE presign runs, so nothing is signed
 * for a request that cannot succeed, and the signed PUT carries the approved Content-Type -- S3
 * will refuse a body of any other type at upload time.
 */
export async function requestUpload(
  storage: StorageService,
  schoolId: string,
  contentClass: ContentClass,
  params: RequestUploadParams,
): Promise<RequestUploadResult> {
  if (!contentClass.allowedContentTypes.has(params.contentType)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Content type ${params.contentType} is not allowed for this content class`,
    );
  }
  if (params.sizeBytes > contentClass.maxSizeBytes) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "File exceeds the maximum size for this content class",
    );
  }

  const storageKey = buildTempKey(schoolId, randomUUID(), params.fileName);
  const presigned = await storage.presign(storageKey, "PUT", params.contentType);
  return { storageKey, presigned };
}

export interface ConfirmUploadParams {
  storageKey: string;
  checksumSha256?: string;
}

export interface ConfirmedUpload {
  /** The permanent key the object now lives at. Persist this, not the temp key. */
  storageKey: string;
  originalFileName: string;
  /** Stored Content-Type -- the value S3 bound at upload, not what the client claimed. */
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
}

export async function confirmUpload(
  storage: StorageService,
  schoolId: string,
  contentClass: ContentClass,
  params: ConfirmUploadParams,
): Promise<ConfirmedUpload> {
  // The key arrives from the client (it was echoed back in the upload-url response), so it is
  // untrusted: it must parse as the four-segment scheme, live under temp/, and belong to this
  // school before it is ever handed to storage. Raising 403 here rather than 404 keeps a caller
  // from probing which foreign keys exist.
  const parsed = assertSchoolOwnedKey(params.storageKey, schoolId, "temp");

  const metadata = await storage.head(params.storageKey);
  if (!metadata) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.STORAGE_OBJECT_NOT_FOUND,
      "No staged upload found for that storage key",
    );
  }

  if (metadata.sizeBytes <= 0) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Staged upload is empty");
  }
  if (metadata.sizeBytes > contentClass.maxSizeBytes) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "File exceeds the maximum size for this content class",
    );
  }
  if (!contentClass.allowedContentTypes.has(metadata.contentType)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Uploaded file type is not allowed for this content class",
    );
  }

  // Verify only when the client supplies a checksum. The check is expensive (a full read of the
  // staged object), so it is opt-in: the caller decides how strong the integrity guarantee must be.
  let checksum: string | null = null;
  if (params.checksumSha256) {
    checksum = await storage.checksumSha256(params.storageKey);
    if (checksum !== params.checksumSha256) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.STORAGE_CHECKSUM_MISMATCH,
        "Uploaded file checksum does not match the checksum you provided",
      );
    }
  }

  const permanentKey = buildPermanentKey(schoolId, parsed.objectId, parsed.filename);
  const { sizeBytes } = await promoteTempObject(storage, params.storageKey, permanentKey);

  return {
    storageKey: permanentKey,
    originalFileName: parsed.filename,
    contentType: metadata.contentType,
    sizeBytes,
    checksumSha256: checksum,
  };
}
