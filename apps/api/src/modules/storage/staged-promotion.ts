/**
 * Promoting staged uploads without holding a database transaction across object storage.
 *
 * A confirm that writes a row naming the promoted object used to do everything in one transaction:
 * HEAD, optional checksum read, CopyObject and DeleteObject, each an S3 round trip, all while a
 * pooled connection sat idle-in-transaction. The flow is now reserve -> call -> finalize, the same
 * shape billing uses for its provider calls:
 *
 *   1. read   -- HEAD (and checksum) the staged object; no transaction open.
 *   2. check  -- one short transaction: authorize, then charge the school's meter for the bytes
 *                (reserveStorage: the quota hard stop and the increment together, as before).
 *   3. copy   -- CopyObject temp/ -> permanent/; no transaction open (copyStagedUploads).
 *   4. write  -- one short transaction: the rows naming the permanent keys, their audit entries.
 *   5. drop   -- DeleteObject on the staged copies, only after step 4 committed (discardStagedUploads).
 *
 * Failure modes, by step:
 *   - 1 or 2 fails: nothing was copied or charged; every staged object is still in temp/.
 *   - 3 fails:      the bytes of the copies that did not land are released (best effort); the staged
 *                   objects are still in temp/ for a retry. A retry copies to the same permanent key.
 *   - 4 fails:      the permanent copies exist with no row naming them -- unreferenced bytes, the
 *                   documented trade (never a row pointing at a missing object). The meter keeps
 *                   them, which is what the bucket says too; the daily reconciliation agrees.
 *   - 5 fails:      swallowed; temp/'s 24h lifecycle rule reclaims the leftover.
 */

import { copyStagedObject, discardStagedObject } from "../../lib/storage/promote";

import {
  assertStorageUploadQuota,
  recordStorageUpload,
  releaseStorageUsage,
} from "./quota-service";

import type { StorageUsage } from "./quota-service";
import type { TxRunner } from "../../db/tenant-tx";
import type { StorageService } from "../../lib/storage";
import type { TransactionSql } from "postgres";

export interface StagedCopy {
  tempKey: string;
  permanentKey: string;
  sizeBytes: number;
}

/**
 * Step 2's charge: refuse past the cap, then count the bytes. Returns the usage after the charge.
 * Call inside the check transaction, after the caller's own authorization.
 */
export async function reserveStorage(tx: TransactionSql, sizeBytes: number): Promise<StorageUsage> {
  const usage = await assertStorageUploadQuota(tx, sizeBytes);
  const bytesUsed = sizeBytes > 0 ? await recordStorageUpload(tx, sizeBytes) : usage.bytesUsed;
  return {
    bytesUsed,
    capBytes: usage.capBytes,
    fractionUsed: usage.capBytes > 0 ? bytesUsed / usage.capBytes : NaN,
  };
}

/**
 * Step 3: copy every staged object to its permanent key, with no transaction open. On a failure
 * the bytes reserved for the copies that did not land are released in a short transaction of their
 * own, and the error is rethrown. The release is best effort: if it cannot be written either, the
 * meter over-counts until the daily reconciliation, which only makes the quota stricter.
 */
export async function copyStagedUploads(
  storage: StorageService,
  runTx: TxRunner,
  copies: readonly StagedCopy[],
): Promise<void> {
  let landed = 0;
  try {
    for (const copy of copies) {
      await copyStagedObject(storage, copy.tempKey, copy.permanentKey);
      landed += 1;
    }
  } catch (error) {
    await releaseReservation(
      runTx,
      copies.slice(landed).reduce((total, copy) => total + copy.sizeBytes, 0),
    );
    throw error;
  }
}

/**
 * Hand back bytes reserved for objects that will not land, in a short transaction of its own. Best
 * effort: if it cannot be written, the meter over-counts until the daily reconciliation, which only
 * makes the quota stricter.
 */
export async function releaseReservation(runTx: TxRunner, sizeBytes: number): Promise<void> {
  if (sizeBytes <= 0) return;
  try {
    await runTx((tx) => releaseStorageUsage(tx, sizeBytes));
  } catch {
    // See above: reconciliation corrects the meter.
  }
}

/** Step 5: drop the staged copies once the rows naming their permanent keys have committed. */
export async function discardStagedUploads(
  storage: StorageService,
  copies: readonly StagedCopy[],
): Promise<void> {
  for (const copy of copies) {
    await discardStagedObject(storage, copy.tempKey);
  }
}
