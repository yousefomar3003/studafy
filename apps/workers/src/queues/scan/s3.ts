/**
 * Thin S3 adapter for the file-scan worker.
 *
 * The worker never needs more than four operations — read an object's bytes, probe existence, copy
 * (permanent -> quarantine), delete (the served copy). Wrapping them behind a narrow interface
 * keeps the AWS SDK imports out of the processor and, more importantly, lets tests hand the worker
 * an in-memory fake: the acceptance criteria (EICAR never served) are provable without a live
 * bucket.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ScanS3Client {
  getObject(params: {
    Bucket: string;
    Key: string;
  }): Promise<{ Body?: AsyncIterable<Uint8Array> | undefined }>;
  headObject(params: { Bucket: string; Key: string }): Promise<{ exists: boolean }>;
  copyObject(params: { Bucket: string; Key: string; CopySource: string }): Promise<void>;
  deleteObject(params: { Bucket: string; Key: string }): Promise<void>;
}

export function createScanS3(options: { region: string; endpoint?: string }): ScanS3Client {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  });

  return {
    async getObject(params) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: params.Bucket, Key: params.Key }),
      );
      return { Body: response.Body as AsyncIterable<Uint8Array> | undefined };
    },

    async headObject(params) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: params.Bucket, Key: params.Key }));
        return { exists: true };
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        ) {
          return { exists: false };
        }
        throw error;
      }
    },

    async copyObject(params) {
      await client.send(
        new CopyObjectCommand({
          Bucket: params.Bucket,
          Key: params.Key,
          // x-amz-copy-source must be URL-encoded; v3 does not do this for us.
          CopySource: encodeURIComponent(params.CopySource),
        }),
      );
    },

    async deleteObject(params) {
      await client.send(new DeleteObjectCommand({ Bucket: params.Bucket, Key: params.Key }));
    },
  };
}
