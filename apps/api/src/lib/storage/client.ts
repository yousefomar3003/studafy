/**
 * Object storage client (ST-103).
 *
 * Built on Bun's native S3 support rather than @aws-sdk/client-s3. The AWS SDK would add a large
 * dependency tree to an app whose only storage needs are presign, head, copy, and delete -- all of
 * which Bun.S3Client covers natively, with no install step and no bundling concern for
 * infra/docker/api.Dockerfile. It speaks plain S3, so MinIO or any other S3-compatible provider
 * works by setting S3_ENDPOINT.
 *
 * The client is optional throughout. Dev and test environments run without object storage
 * configured, and the app must still boot: routes that need storage answer 503 (see
 * requireStorage below), and read paths degrade to a null download URL rather than failing the
 * whole request. That is why every consumer takes `StorageService | null` instead of reaching for
 * a module-level singleton.
 */

import { ERROR_CODES } from "@studafy/constants";
import { S3Client } from "bun";

import { CodedHttpException } from "../../coded-http-exception";

import type { Env } from "../../env";

/** How a pre-signed URL may be used. */
export type PresignMethod = "GET" | "PUT";

export interface PresignedUrl {
  url: string;
  /** Absolute expiry, for the client to reason about without re-deriving the TTL. */
  expiresAt: Date;
}

export interface StorageService {
  /** Seconds a generated URL stays valid. */
  readonly ttlSeconds: number;
  presign(key: string, method: PresignMethod, contentType?: string): PresignedUrl;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Construct the storage service, or return null when object storage is not configured.
 *
 * env.ts validates the credential variables as an all-or-nothing group, so a partially configured
 * environment fails at startup rather than here. Checking the bucket alone is therefore sufficient
 * to distinguish "configured" from "not configured".
 */
export function createStorageService(env: Env): StorageService | null {
  if (!env.S3_APP_FILES_BUCKET) return null;

  const client = new S3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    bucket: env.S3_APP_FILES_BUCKET,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  });

  const ttlSeconds = env.S3_PRESIGN_TTL_SECONDS;

  return {
    ttlSeconds,

    presign(key, method, contentType) {
      // Purely local: an HMAC over the request's canonical form. No network call, so this is safe
      // to do while holding a database transaction open -- though callers avoid it anyway.
      const url = client.presign(key, {
        method,
        expiresIn: ttlSeconds,
        ...(contentType ? { type: contentType } : {}),
      });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
    },

    async exists(key) {
      return client.exists(key);
    },

    async size(key) {
      return client.size(key);
    },

    async copy(sourceKey, destinationKey) {
      // S3 has no move. The runbook spells this out: the temp -> permanent transition is a
      // CopyObject followed by a DeleteObject, and the delete is the caller's second step so a
      // failed copy leaves the source intact to retry against.
      await client.write(destinationKey, client.file(sourceKey));
    },

    async remove(key) {
      await client.delete(key);
    },
  };
}

/**
 * Return the storage service or refuse the request.
 *
 * 503 rather than 500: the request is well-formed and would succeed against a properly configured
 * deployment, so this is "the server is missing a dependency", not "the server is broken". A caller
 * seeing it should retry later or escalate, not rewrite their request.
 */
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
