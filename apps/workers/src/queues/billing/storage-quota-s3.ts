/**
 * S3 list adapter for the storage-quota reconciliation sweep.
 *
 * The sweep enumerates the objects under a school's prefixes with their sizes and ages, and — only
 * when orphan removal is enabled (./storage-orphan-sweep.ts) — deletes one. The workers process cannot import apps/api's lib/storage client (the
 * worker image does not carry the API). Wrapping it behind a narrow interface keeps the AWS SDK
 * import out of the processor and lets tests hand the sweep an in-memory fake, the same shape as
 * the scan queue's s3.ts.
 */

import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

export interface StorageQuotaS3Object {
  key: string;
  sizeBytes: number;
  /** When the object was written; absent when the listing did not say. */
  lastModified?: Date;
}

export interface StorageQuotaS3Client {
  list(prefix: string): AsyncIterable<StorageQuotaS3Object>;
  /** Delete one object. Used only by orphan removal, which is off by default. */
  remove?(key: string): Promise<void>;
}

export function createStorageQuotaS3(options: {
  region: string;
  endpoint?: string;
  bucket: string;
}): StorageQuotaS3Client {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  });

  return {
    async *list(prefix) {
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: options.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue;
          yield {
            key: item.Key,
            sizeBytes: Number(item.Size ?? 0),
            ...(item.LastModified ? { lastModified: item.LastModified } : {}),
          };
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
}
