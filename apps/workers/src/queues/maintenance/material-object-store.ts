/**
 * The S3 operations the abandoned material sweep needs: read an object's size, delete it. Behind a
 * narrow interface so the sweep's tests use an in-memory fake, the same shape as
 * ../billing/storage-quota-s3.ts.
 */

import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { MaterialObjectStore } from "./abandoned-material-sweep";

export function createMaterialObjectStore(options: {
  region: string;
  endpoint?: string;
  bucket: string;
}): MaterialObjectStore {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  });

  return {
    async head(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }));
        return { sizeBytes: Number(head.ContentLength ?? 0) };
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        ) {
          return null;
        }
        throw error;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
}
