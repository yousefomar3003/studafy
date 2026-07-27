/**
 * temp/ -> permanent/ promotion tests (ST-103).
 *
 * Runs against a fake StorageService rather than a bucket. The behaviour under test is ordering and
 * failure handling, not S3 itself, and those are exactly the parts a live-bucket test would be
 * least able to provoke on demand.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { CodedHttpException } from "../../../../coded-http-exception";
import { promoteTempObject } from "../../../../lib/storage/promote";

import type { PresignedUrl, StorageService } from "../../../../lib/storage";

interface FakeStorage extends StorageService {
  readonly calls: string[];
  readonly objects: Map<string, number>;
}

function fakeStorage(
  seed: Record<string, number> = {},
  overrides: Partial<StorageService> = {},
): FakeStorage {
  const objects = new Map<string, number>(Object.entries(seed));
  const calls: string[] = [];

  const base: StorageService = {
    ttlSeconds: 900,
    presign(key): PresignedUrl {
      return { url: `https://storage.example/${key}?signed`, expiresAt: new Date(Date.now() + 1) };
    },
    async exists(key) {
      calls.push(`exists:${key}`);
      return objects.has(key);
    },
    async size(key) {
      calls.push(`size:${key}`);
      return objects.get(key) ?? 0;
    },
    async copy(source, destination) {
      calls.push(`copy:${source}->${destination}`);
      objects.set(destination, objects.get(source) ?? 0);
    },
    async remove(key) {
      calls.push(`remove:${key}`);
      objects.delete(key);
    },
  };

  return Object.assign(base, overrides, { calls, objects }) as FakeStorage;
}

const TEMP_KEY = "temp/school-1/object-1/notes.pdf";
const PERMANENT_KEY = "permanent/school-1/object-1/notes.pdf";

describe("promoteTempObject", () => {
  test("copies then deletes, in that order", async () => {
    // The order is the whole safety property: a crash between the two leaves a duplicate under
    // temp/ that the bucket's 24h rule reclaims, whereas delete-first would destroy the object.
    const storage = fakeStorage({ [TEMP_KEY]: 2048 });

    const result = await promoteTempObject(storage, TEMP_KEY, PERMANENT_KEY);

    expect(result).toEqual({ key: PERMANENT_KEY, sizeBytes: 2048 });
    expect(storage.calls).toEqual([
      `exists:${TEMP_KEY}`,
      `size:${TEMP_KEY}`,
      `copy:${TEMP_KEY}->${PERMANENT_KEY}`,
      `remove:${TEMP_KEY}`,
    ]);
    expect(storage.objects.has(PERMANENT_KEY)).toBe(true);
    expect(storage.objects.has(TEMP_KEY)).toBe(false);
  });

  test("rejects a key that was never uploaded", async () => {
    // Without this check a client could confirm metadata for a key it never wrote, leaving a row
    // that renders as a permanently broken download.
    const storage = fakeStorage();

    try {
      await promoteTempObject(storage, TEMP_KEY, PERMANENT_KEY);
      throw new Error("expected promoteTempObject to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(404);
      expect((error as CodedHttpException).code).toBe("STORAGE_OBJECT_NOT_FOUND");
    }

    expect(storage.calls).toEqual([`exists:${TEMP_KEY}`]);
  });

  test("rejects an empty staged object", async () => {
    const storage = fakeStorage({ [TEMP_KEY]: 0 });

    await expect(promoteTempObject(storage, TEMP_KEY, PERMANENT_KEY)).rejects.toThrow(
      CodedHttpException,
    );
    // Nothing was copied: a zero-byte upload is a failed upload, not an attachment.
    expect(storage.calls).not.toContain(`copy:${TEMP_KEY}->${PERMANENT_KEY}`);
  });

  test("takes the size from storage, not from the caller", async () => {
    // size_bytes must describe the object that was actually uploaded. Trusting a client-supplied
    // value would let the recorded size drift from reality with no way to detect it.
    const storage = fakeStorage({ [TEMP_KEY]: 4096 });

    const result = await promoteTempObject(storage, TEMP_KEY, PERMANENT_KEY);

    expect(result.sizeBytes).toBe(4096);
  });

  test("succeeds even when cleaning up the staged copy fails", async () => {
    // The object is correctly in place by this point; failing the request would roll back an
    // attachment over a leftover the lifecycle rule collects anyway.
    const storage = fakeStorage(
      { [TEMP_KEY]: 512 },
      {
        async remove() {
          throw new Error("network partition");
        },
      },
    );

    const result = await promoteTempObject(storage, TEMP_KEY, PERMANENT_KEY);

    expect(result.sizeBytes).toBe(512);
    expect(storage.objects.has(PERMANENT_KEY)).toBe(true);
  });

  test("propagates a copy failure", async () => {
    // The inverse of the cleanup case: if the copy did not happen there is no object to record,
    // and the caller's transaction must not commit a row pointing at nothing.
    const storage = fakeStorage(
      { [TEMP_KEY]: 512 },
      {
        async copy() {
          throw new Error("bucket unavailable");
        },
      },
    );

    await expect(promoteTempObject(storage, TEMP_KEY, PERMANENT_KEY)).rejects.toThrow(
      "bucket unavailable",
    );
  });
});
