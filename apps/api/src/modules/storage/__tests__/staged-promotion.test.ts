/**
 * reserve -> copy -> write -> drop (staged-promotion.ts): the failure paths of the steps that run
 * with no transaction open. A fake StorageService and a fake transaction runner that records the
 * meter statements it is asked to run.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { copyStagedUploads, discardStagedUploads } from "../staged-promotion";

import type { TxRunner } from "../../../db/tenant-tx";
import type { StorageService } from "../../../lib/storage";
import type { StagedCopy } from "../staged-promotion";
import type { TransactionSql } from "postgres";

function fakeStorage(overrides: Partial<StorageService> = {}) {
  const calls: string[] = [];
  const base: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign: (key) => ({ url: key, expiresAt: new Date() }),
    exists: async () => true,
    size: async () => 1,
    head: async () => ({ contentType: "image/png", sizeBytes: 1 }),
    checksumSha256: async () => "x",
    async copy(source, destination) {
      calls.push(`copy:${source}->${destination}`);
    },
    async remove(key) {
      calls.push(`remove:${key}`);
    },
    async *list() {
      yield* [];
    },
  };
  return { storage: Object.assign(base, overrides), calls };
}

/** Records the byte delta of every meter statement (app.add_storage_usage) it runs. */
function recordingRunner(options: { fail?: boolean } = {}) {
  const meterDeltas: number[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("add_storage_usage")) meterDeltas.push(values[0] as number);
    return Promise.resolve([{ add_storage_usage: "0" }]);
  }) as unknown as TransactionSql;
  const runTx: TxRunner = async (fn) => {
    if (options.fail) throw new Error("database unavailable");
    return fn(tx);
  };
  return { runTx, meterDeltas };
}

const COPIES: StagedCopy[] = [
  { tempKey: "temp/s/a/a.png", permanentKey: "permanent/s/a/a.png", sizeBytes: 100 },
  { tempKey: "temp/s/b/b.png", permanentKey: "permanent/s/b/b.png", sizeBytes: 20 },
  { tempKey: "temp/s/c/c.png", permanentKey: "permanent/s/c/c.png", sizeBytes: 3 },
];

describe("copyStagedUploads", () => {
  test("copies every object and touches neither the meter nor temp/", async () => {
    const { storage, calls } = fakeStorage();
    const { runTx, meterDeltas } = recordingRunner();

    await copyStagedUploads(storage, runTx, COPIES);

    expect(calls).toEqual(COPIES.map((c) => `copy:${c.tempKey}->${c.permanentKey}`));
    expect(meterDeltas).toEqual([]);
  });

  test("a failed copy releases the bytes of the copies that did not land, then rethrows", async () => {
    let copies = 0;
    const { storage } = fakeStorage({
      async copy() {
        copies += 1;
        if (copies === 2) throw new Error("bucket unavailable");
      },
    });
    const { runTx, meterDeltas } = recordingRunner();

    await expect(copyStagedUploads(storage, runTx, COPIES)).rejects.toThrow("bucket unavailable");

    // The first object landed (it is in the bucket, so it stays counted); the other two did not.
    expect(meterDeltas).toEqual([-23]);
  });

  test("a release that cannot be written does not mask the copy's own error", async () => {
    const { storage } = fakeStorage({
      async copy() {
        throw new Error("bucket unavailable");
      },
    });
    const { runTx } = recordingRunner({ fail: true });

    await expect(copyStagedUploads(storage, runTx, COPIES)).rejects.toThrow("bucket unavailable");
  });
});

describe("discardStagedUploads", () => {
  test("drops every staged copy and swallows a failed delete", async () => {
    const removed: string[] = [];
    const { storage } = fakeStorage({
      async remove(key) {
        removed.push(key);
        if (removed.length === 1) throw new Error("network partition");
      },
    });

    await discardStagedUploads(storage, COPIES);

    expect(removed).toEqual(COPIES.map((c) => c.tempKey));
  });
});
