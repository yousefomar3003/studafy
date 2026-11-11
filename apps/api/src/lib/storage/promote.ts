/**
 * temp/ -> permanent/ promotion (ST-103).
 *
 * docs/runbooks/storage-conventions.md describes this as the step that "doesn't exist yet"; this is
 * it. A pre-signed upload lands under `temp/<schoolId>/...`, where the bucket's 24h lifecycle rule
 * will eventually reclaim it. Confirming an upload means proving the object is really there and
 * moving it out from under that rule.
 *
 * S3 has no move operation, so a promotion is CopyObject followed by DeleteObject. The ordering
 * matters and is not interchangeable: copy first means a crash between the two steps leaves a
 * duplicate in `temp/` that the lifecycle rule collects on its own, whereas delete-first would lose
 * the object outright.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { StorageService } from "./client";

export interface PromotedObject {
  key: string;
  sizeBytes: number;
}

export interface PromoteOptions {
  /**
   * Called with the staged object's size once it has been read, before the copy to the permanent
   * key. Injected by confirm flows so the storage-quota hard stop can run against the stored size
   * before any mutation -- and its errors propagate before the temp object is touched, so a
   * refused promotion leaves nothing behind. Exists as a hook rather than a database dependency
   * because this module is storage infra and must stay database-free.
   */
  onSize?: (sizeBytes: number) => Promise<void>;
  /** Promote under the sensitive-documents KMS key (ADR-019); see StorageService.copy. */
  sensitive?: boolean;
  /**
   * The stored size, when the caller has already read it (inspectStagedUpload / readStagedObject).
   * The existence and size HEAD is then skipped: it would only re-read what the caller just read.
   */
  knownSizeBytes?: number;
}

/**
 * The staged object's stored size, in one HEAD. 404 when it was never uploaded (or has aged out of
 * temp/), 400 when it is empty: a zero-byte upload is a failed upload, not an attachment.
 *
 * The size is what callers persist as size_bytes: taking it from the bucket is what makes the row
 * describe the object that was actually uploaded rather than what the client claimed.
 */
export async function readStagedSize(storage: StorageService, tempKey: string): Promise<number> {
  const metadata = await storage.head(tempKey);
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
  return metadata.sizeBytes;
}

/**
 * Verify a staged upload exists, copy it to its permanent key, and drop the staged copy.
 *
 * The existence check is the reason this is a server-side confirm step at all rather than the
 * client simply asserting it uploaded. Without it a caller could POST attachment metadata for a key
 * they never wrote, producing a row that renders as a broken download forever.
 *
 * Both keys must already have been validated by assertSchoolOwnedKey -- this function does not
 * re-check tenancy, and calling it with an unvalidated key would copy across a tenant boundary.
 *
 * Not for use inside a database transaction: every step is an S3 round trip. Flows that write a
 * row naming the object use copyStagedObject + discardStagedObject around their transactions
 * instead (see modules/storage/staged-promotion.ts).
 */
export async function promoteTempObject(
  storage: StorageService,
  tempKey: string,
  permanentKey: string,
  options: PromoteOptions = {},
): Promise<PromotedObject> {
  const sizeBytes = options.knownSizeBytes ?? (await readStagedSize(storage, tempKey));

  await options.onSize?.(sizeBytes);

  await copyStagedObject(storage, tempKey, permanentKey, { sensitive: options.sensitive });

  // A failed cleanup has already been rendered harmless by the 24h lifecycle rule on temp/, and
  // failing the caller's request over it would roll back an object that is correctly in place.
  await discardStagedObject(storage, tempKey);

  return { key: permanentKey, sizeBytes };
}

/**
 * The copy half of a promotion: the object now exists at `permanentKey` and still at `tempKey`.
 * Copy-then-delete (never delete-first) is the safety property: a crash between the two leaves a
 * duplicate under temp/ that the lifecycle rule collects, never a lost object.
 */
export async function copyStagedObject(
  storage: StorageService,
  tempKey: string,
  permanentKey: string,
  options: { sensitive?: boolean } = {},
): Promise<void> {
  try {
    if (options.sensitive) {
      await storage.copy(tempKey, permanentKey, { sensitive: true });
    } else {
      await storage.copy(tempKey, permanentKey);
    }
  } catch (error) {
    // The staged object was read moments ago but is gone now (aged out of temp/, or a concurrent
    // confirm of the same key already discarded it): the same answer as never uploaded.
    if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.STORAGE_OBJECT_NOT_FOUND,
        "No staged upload found for that storage key",
      );
    }
    throw error;
  }
}

/**
 * The delete half of a promotion, best effort. Run only once the row naming the permanent copy
 * has committed: until then the staged object is what a retry needs. A failure is swallowed --
 * the 24h lifecycle rule on temp/ reclaims the leftover.
 */
export async function discardStagedObject(storage: StorageService, tempKey: string): Promise<void> {
  try {
    await storage.remove(tempKey);
  } catch {
    // Intentionally swallowed -- see above. The object ages out of temp/ on its own.
  }
}
