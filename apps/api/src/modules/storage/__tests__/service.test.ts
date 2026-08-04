/**
 * Storage service tests (SAD §22).
 *
 * Runs against a fake StorageService rather than a bucket. The behaviour under test is the content
 * class policy: reject before signing, key shape, tenant boundary on the confirm leg, and
 * promotion ordering — exactly the parts a live-bucket test could not provoke on demand.
 */

// Imported before anything else — see the note in src/middleware/authz.test.ts.
import "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { CodedHttpException } from "../../../coded-http-exception";
import { getContentClass } from "../content-classes";
import { confirmUpload, requestUpload } from "../service";

import type { ObjectMetadata, PresignedUrl, StorageService } from "../../../lib/storage";

const VALID_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface StoredObject extends ObjectMetadata {
  checksumSha256: string;
}

interface FakeStorage extends StorageService {
  readonly calls: string[];
  readonly objects: Map<string, StoredObject>;
}

function fakeStorage(
  seed: Record<string, { sizeBytes: number; contentType?: string; checksumSha256?: string }> = {},
): FakeStorage {
  const objects = new Map<string, StoredObject>();
  for (const [key, entry] of Object.entries(seed)) {
    objects.set(key, {
      sizeBytes: entry.sizeBytes,
      contentType: entry.contentType ?? "application/pdf",
      checksumSha256: entry.checksumSha256 ?? VALID_SHA,
    });
  }
  const calls: string[] = [];

  const base: StorageService = {
    ttlSeconds: 900,
    presign(key): PresignedUrl {
      calls.push(`presign:${key}`);
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async exists(key) {
      calls.push(`exists:${key}`);
      return objects.has(key);
    },
    async size(key) {
      calls.push(`size:${key}`);
      return objects.get(key)?.sizeBytes ?? 0;
    },
    async head(key) {
      calls.push(`head:${key}`);
      const object = objects.get(key);
      return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
    },
    async checksumSha256(key) {
      calls.push(`checksum:${key}`);
      return objects.get(key)?.checksumSha256 ?? "";
    },
    async copy(source, destination) {
      calls.push(`copy:${source}->${destination}`);
      const object = objects.get(source);
      if (object) objects.set(destination, { ...object });
    },
    async remove(key) {
      calls.push(`remove:${key}`);
      objects.delete(key);
    },
  };

  return Object.assign(base, { calls, objects }) as FakeStorage;
}

const CLASS = getContentClass("assignment.attachment");
const SCHOOL_ID = "school-1";
const TEMP_KEY = "temp/school-1/object-1/notes.pdf";
const PERMANENT_KEY = "permanent/school-1/object-1/notes.pdf";

// ---------------------------------------------------------------------------
// requestUpload
// ---------------------------------------------------------------------------

describe("requestUpload", () => {
  test("returns a presigned PUT under the caller's temp prefix", async () => {
    const storage = fakeStorage();

    const result = await requestUpload(storage, SCHOOL_ID, CLASS, {
      fileName: "notes.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
    });

    expect(storage.calls).toEqual([`presign:${result.storageKey}`]);
    expect(result.presigned.url).toContain(result.storageKey);

    // The key is always temp/<schoolId>/<objectId>/<filename> — the objectId is server-generated,
    // so a caller cannot steer the key to another school or another category.
    const segments = result.storageKey.split("/");
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe("temp");
    expect(segments[1]).toBe(SCHOOL_ID);
    expect(segments[3]).toBe("notes.pdf");
  });

  test("rejects a content type outside the class allowlist before signing", async () => {
    const storage = fakeStorage();

    await expect(
      requestUpload(storage, SCHOOL_ID, CLASS, {
        fileName: "notes.html",
        contentType: "text/html",
        sizeBytes: 2048,
      }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });

    expect(storage.calls).toHaveLength(0);
  });

  test("rejects an oversize claim before signing", async () => {
    const storage = fakeStorage();

    await expect(
      requestUpload(storage, SCHOOL_ID, CLASS, {
        fileName: "big.pdf",
        contentType: "application/pdf",
        sizeBytes: CLASS.maxSizeBytes + 1,
      }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });

    expect(storage.calls).toHaveLength(0);
  });

  test("rejects a path-traversal filename via the key builder", async () => {
    const storage = fakeStorage();

    await expect(
      requestUpload(storage, SCHOOL_ID, CLASS, {
        fileName: "../notes.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
      }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });

    expect(storage.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// confirmUpload
// ---------------------------------------------------------------------------

describe("confirmUpload", () => {
  test("verifies, then promotes a valid staged object, reporting stored facts", async () => {
    const storage = fakeStorage({ [TEMP_KEY]: { sizeBytes: 4096 } });

    const result = await confirmUpload(storage, SCHOOL_ID, CLASS, {
      storageKey: TEMP_KEY,
      checksumSha256: VALID_SHA,
    });

    expect(result).toEqual({
      storageKey: PERMANENT_KEY,
      originalFileName: "notes.pdf",
      contentType: "application/pdf",
      sizeBytes: 4096,
      checksumSha256: VALID_SHA,
    });

    // head (stored facts) → checksum → promote's exists/size/copy/remove.
    expect(storage.calls).toEqual([
      `head:${TEMP_KEY}`,
      `checksum:${TEMP_KEY}`,
      `exists:${TEMP_KEY}`,
      `size:${TEMP_KEY}`,
      `copy:${TEMP_KEY}->${PERMANENT_KEY}`,
      `remove:${TEMP_KEY}`,
    ]);
    expect(storage.objects.has(PERMANENT_KEY)).toBe(true);
    expect(storage.objects.has(TEMP_KEY)).toBe(false);
  });

  test("returns a null checksum and skips the read when none was supplied", async () => {
    const storage = fakeStorage({ [TEMP_KEY]: { sizeBytes: 2048 } });

    const result = await confirmUpload(storage, SCHOOL_ID, CLASS, { storageKey: TEMP_KEY });

    expect(result.checksumSha256).toBeNull();
    expect(storage.calls).not.toContain(`checksum:${TEMP_KEY}`);
  });

  test("rejects a key that was never uploaded", async () => {
    const storage = fakeStorage();

    try {
      await confirmUpload(storage, SCHOOL_ID, CLASS, { storageKey: TEMP_KEY });
      throw new Error("expected confirmUpload to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(404);
      expect((error as CodedHttpException).code).toBe("STORAGE_OBJECT_NOT_FOUND");
    }

    expect(storage.calls).toEqual([`head:${TEMP_KEY}`]);
  });

  test("rejects a foreign or non-temp key with 403 before any storage call", async () => {
    for (const foreignKey of [
      "temp/other-school/object-1/notes.pdf",
      "permanent/school-1/object-1/notes.pdf",
      "not-a-key",
    ]) {
      const storage = fakeStorage({ [TEMP_KEY]: { sizeBytes: 2048 } });

      try {
        await confirmUpload(storage, SCHOOL_ID, CLASS, { storageKey: foreignKey });
        throw new Error("expected confirmUpload to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CodedHttpException);
        expect((error as CodedHttpException).status).toBe(403);
        expect((error as CodedHttpException).code).toBe("STORAGE_KEY_FORBIDDEN");
      }

      expect(storage.calls).toEqual([]);
    }
  });

  test("rejects an empty staged object", async () => {
    const storage = fakeStorage({ [TEMP_KEY]: { sizeBytes: 0 } });

    await expect(
      confirmUpload(storage, SCHOOL_ID, CLASS, { storageKey: TEMP_KEY }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(storage.calls).not.toContain(`copy:${TEMP_KEY}->${PERMANENT_KEY}`);
  });

  test("rejects an oversize stored object — the claim-small-upload-big gap", async () => {
    const storage = fakeStorage({ [TEMP_KEY]: { sizeBytes: CLASS.maxSizeBytes + 1 } });

    await expect(
      confirmUpload(storage, SCHOOL_ID, CLASS, { storageKey: TEMP_KEY }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(storage.calls).not.toContain(`copy:${TEMP_KEY}->${PERMANENT_KEY}`);
  });

  test("rejects a stored type outside the class allowlist", async () => {
    const storage = fakeStorage({
      [TEMP_KEY]: { sizeBytes: 2048, contentType: "text/html" },
    });

    await expect(
      confirmUpload(storage, SCHOOL_ID, CLASS, { storageKey: TEMP_KEY }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(storage.calls).not.toContain(`copy:${TEMP_KEY}->${PERMANENT_KEY}`);
  });

  test("rejects a checksum that does not match the stored bytes", async () => {
    const storage = fakeStorage({
      [TEMP_KEY]: { sizeBytes: 2048, checksumSha256: VALID_SHA },
    });

    try {
      await confirmUpload(storage, SCHOOL_ID, CLASS, {
        storageKey: TEMP_KEY,
        checksumSha256: "a".repeat(64),
      });
      throw new Error("expected confirmUpload to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(400);
      expect((error as CodedHttpException).code).toBe("STORAGE_CHECKSUM_MISMATCH");
    }

    // Nothing was promoted.
    expect(storage.calls).not.toContain(`copy:${TEMP_KEY}->${PERMANENT_KEY}`);
  });
});
