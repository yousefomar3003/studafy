import { createHash } from "node:crypto";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { Env } from "../../env";

export type PresignMethod = "GET" | "PUT";

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

/** What S3 actually stored for an object -- read back from the bucket, never from the caller. */
export interface ObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

/** One object surfaced by {@link StorageService.list}. */
export interface ListedObject {
  key: string;
  sizeBytes: number;
}

export interface StorageService {
  readonly ttlSeconds: number;
  presign(
    key: string,
    method: PresignMethod,
    contentType?: string,
    ttlOverrideSeconds?: number,
  ): PresignedUrl | Promise<PresignedUrl>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  /**
   * Metadata as stored, or null when the object does not exist.
   *
   * Unlike exists()+size(), this is a single HEAD round trip, and the returned contentType is the
   * value bound at PUT time -- the real object, not whatever a client claimed in a request body.
   */
  head(key: string): Promise<ObjectMetadata | null>;
  /** SHA-256 of the object body, streamed from storage. */
  checksumSha256(key: string): Promise<string>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Iterate every object under a key prefix, streaming pagination internally.
   *
   * Used by storage-quota reconciliation to recompute a school's meter from bucket inventory; the
   * trailing slash on the prefix is what pins it to one tenant (permanent/<schoolId>/ and friends).
   */
  list(prefix: string): AsyncIterable<ListedObject>;
}

export function createStorageService(env: Env): StorageService | null {
  if (!env.S3_APP_FILES_BUCKET || !env.S3_REGION) return null;

  const bucket = env.S3_APP_FILES_BUCKET;
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  const ttlSeconds = env.S3_PRESIGN_TTL_SECONDS;

  return {
    ttlSeconds,

    async presign(key, method, contentType, ttlOverrideSeconds) {
      const expiresIn = ttlOverrideSeconds ?? ttlSeconds;
      const command =
        method === "PUT"
          ? new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              ...(contentType ? { ContentType: contentType } : {}),
            })
          : new GetObjectCommand({
              Bucket: bucket,
              Key: key,
              ResponseContentDisposition: `attachment; filename="${key.split("/").at(-1) ?? "download"}"`,
            });
      const url = await getSignedUrl(client, command, { expiresIn });
      return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404) return false;
        throw error;
      }
    },

    async size(key) {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return Number(result.ContentLength ?? 0);
    },

    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          contentType: result.ContentType ?? "application/octet-stream",
          sizeBytes: Number(result.ContentLength ?? 0),
        };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404) return null;
        throw error;
      }
    },

    async checksumSha256(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = response.Body as AsyncIterable<Uint8Array> | undefined;
      if (!body) {
        throw new Error("Object body is not streamable");
      }
      const hash = createHash("sha256");
      for await (const chunk of body) {
        hash.update(chunk);
      }
      return hash.digest("hex");
    },

    async copy(sourceKey, destinationKey) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: destinationKey,
          CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
        }),
      );
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async *list(prefix) {
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        );
        for (const item of page.Contents ?? []) {
          yield {
            key: item.Key ?? "",
            sizeBytes: Number(item.Size ?? 0),
          };
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);
    },
  };
}

export function requireStorage(storage: StorageService | null): StorageService {
  if (!storage) {
    throw new CodedHttpException(
      503,
      ERROR_CODES.STORAGE_NOT_CONFIGURED,
      "Object storage is not configured for this deployment",
    );
  }
  return storage;
}
