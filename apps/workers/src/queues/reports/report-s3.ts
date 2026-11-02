/**
 * S3 adapter for the report framework (ST-175).
 *
 * The framework needs exactly three bucket operations — put an artifact, remove an expired one,
 * and pre-sign a GET — and the workers process cannot import apps/api's lib/storage client (the
 * worker image does not carry the API). Wrapping them behind the narrow `ReportS3Client` interface
 * keeps the AWS SDK import out of the runner and lets tests hand it an in-memory fake, the same
 * shape as the scan and storage-quota adapters.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { ReportS3Client } from "./report-types";

/** Download links stay valid for 24h, matching the finance API's persisted signed URL TTL. */
export const REPORT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

export function createReportS3(options: {
  region: string;
  endpoint?: string;
  bucket: string;
}): ReportS3Client {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  });

  return {
    async put(key, artifact, { contentType, contentDisposition }) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: artifact,
          ContentType: contentType,
          ContentDisposition: contentDisposition,
        }),
      );
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
    async presignGet(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: options.bucket, Key: key }), {
        expiresIn: REPORT_SIGNED_URL_TTL_SECONDS,
      });
    },
  };
}
