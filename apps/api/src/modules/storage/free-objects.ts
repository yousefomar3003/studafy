/**
 * Free the stored files behind rows a request just deleted or replaced.
 *
 * Called only after the transaction that removed the row (or pointed it at a new file) has
 * committed. Removing an object inside that transaction would destroy a file the database could
 * still roll back to; removing it afterwards can at worst leave an unreferenced object, which the
 * daily reconciliation keeps counted and the orphan sweep reports.
 *
 * A key some other row of the school still points at is kept (app.referenced_storage_keys, 000204):
 * an expense may be given any of its school's permanent/ keys, and a material's key is derived from
 * its file name, so a re-upload can already be using it. If that check cannot run, nothing is
 * removed. Each remaining key is read (HEAD) for its stored size, removed, and only the bytes
 * actually removed are released from the school's meter, so the space shows as free immediately
 * rather than at the next 06:00 recount. A key that is already gone, not this school's, or not
 * under `permanent/` frees nothing. Every failure is swallowed: the row change has already
 * succeeded, and the request must not fail because the bucket was slow.
 */

import { releaseStorageUsage } from "./quota-service";

import type { TxRunner } from "../../db/tenant-tx";
import type { StorageService } from "../../lib/storage";

export async function freeStoredObjects(
  storage: StorageService | null | undefined,
  runTx: TxRunner,
  schoolId: string,
  keys: readonly (string | null | undefined)[],
): Promise<number> {
  if (!storage) return 0;
  const prefix = `permanent/${schoolId}/`;
  const candidates = [...new Set(keys)].filter(
    (key): key is string => typeof key === "string" && key.startsWith(prefix),
  );
  if (candidates.length === 0) return 0;

  let unreferenced: string[];
  try {
    const live = await runTx(
      (tx) => tx<{ key: string }[]>`
        SELECT app.referenced_storage_keys(${candidates}::text[]) AS key
      `,
    );
    const kept = new Set(live.map((row) => row.key));
    unreferenced = candidates.filter((key) => !kept.has(key));
  } catch {
    return 0;
  }

  let freed = 0;
  for (const key of unreferenced) {
    try {
      const stored = await storage.head(key);
      if (!stored) continue;
      await storage.remove(key);
      freed += stored.sizeBytes;
    } catch {
      // Left in the bucket: still counted by reconciliation, reported by the orphan sweep.
    }
  }

  if (freed > 0) {
    try {
      await runTx((tx) => releaseStorageUsage(tx, freed));
    } catch {
      // The objects are gone; the next reconciliation brings the meter down to match.
    }
  }
  return freed;
}
