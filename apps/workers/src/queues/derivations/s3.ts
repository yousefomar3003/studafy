/**
 * Thin S3 adapter for the derivations worker.
 *
 * The worker needs exactly two operations — read a material's original bytes, write a derived
 * JPEG — so a narrow interface keeps the AWS SDK imports out of the processor and lets tests hand
 * the worker an in-memory fake, the same seam `scan/s3.ts` establishes for the file-scan worker.
 * Originals are only ever read; derived images are written under new keys, so an "original
 * untouched" acceptance is provable against the fake's object map.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface DerivationS3Client {
  getObject(params: {
    Bucket: string;
    Key: string;
  }): Promise<{ Body?: AsyncIterable<Uint8Array> | undefined }>;
  putObject(params: {
    Bucket: string;
    Key: string;
    Body: Uint8Array;
    ContentType: string;
  }): Promise<void>;
}

export function createDerivationS3(options: {
  region: string;
  endpoint?: string;
}): DerivationS3Client {
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

    async putObject(params) {
      await client.send(
        new PutObjectCommand({
          Bucket: params.Bucket,
          Key: params.Key,
          Body: params.Body,
          ContentType: params.ContentType,
        }),
      );
    },
  };
}
