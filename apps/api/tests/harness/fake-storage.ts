import type { StorageService } from "../../src/lib/storage";

export interface FakeStoredObject {
  contentType: string;
  sizeBytes: number;
}

/**
 * An in-memory StorageService: enough for routes that presign, inspect, copy and delete objects to
 * run end to end without S3. `objects` is exposed so a test can "upload" by setting a key.
 */
export function fakeStorage(): StorageService & { objects: Map<string, FakeStoredObject> } {
  const objects = new Map<string, FakeStoredObject>();
  const base: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key, _method, _contentType, ttlOverrideSeconds) {
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + (ttlOverrideSeconds ?? 900) * 1000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key)?.sizeBytes ?? 0;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
    },
    async checksumSha256() {
      return "a".repeat(64);
    },
    async copy(source, destination) {
      const object = objects.get(source);
      if (object) objects.set(destination, { ...object });
    },
    async remove(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, object] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes: object.sizeBytes };
      }
    },
  };
  return Object.assign(base, { objects });
}
