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

/**
 * Verify a staged upload exists, copy it to its permanent key, and drop the staged copy.
 *
 * The existence check is the reason this is a server-side confirm step at all rather than the
 * client simply asserting it uploaded. Without it a caller could POST attachment metadata for a key
 * they never wrote, producing a row that renders as a broken download forever.
 *
 * Both keys must already have been validated by assertSchoolOwnedKey -- this function does not
 * re-check tenancy, and calling it with an unvalidated key would copy across a tenant boundary.
 */
export async function promoteTempObject(
  storage: StorageService,
  tempKey: string,
  permanentKey: string,
): Promise<PromotedObject> {
  if (!(await storage.exists(tempKey))) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.STORAGE_OBJECT_NOT_FOUND,
      "No staged upload found for that storage key",
    );
  }

  // Read the size before the copy: it is the value persisted alongside the attachment row, and
  // taking it from the source is what makes size_bytes describe the object that was actually
  // uploaded rather than what the client claimed in its request body.
  const sizeBytes = await storage.size(tempKey);

  if (sizeBytes <= 0) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Staged upload is empty");
  }

  await storage.copy(tempKey, permanentKey);

  // Deliberately not awaited inside a try/catch that rethrows: a failed cleanup has already been
  // rendered harmless by the 24h lifecycle rule on temp/, and failing the caller's request over it
  // would roll back an attachment whose object is correctly in place.
  try {
    await storage.remove(tempKey);
  } catch {
    // Intentionally swallowed -- see above. The object ages out of temp/ on its own.
  }

  return { key: permanentKey, sizeBytes };
}
