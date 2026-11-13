/**
 * Object storage for data subject request exports: read the stored files an export copies, and
 * write the export's ZIP archive as a stream.
 *
 * The archive's length is not known until it is finished and can be far larger than the worker's
 * memory (a school's every upload), so it is written as a multipart upload holding one part in
 * memory at a time. Every part but the last has the same size: Cloudflare R2 requires that, and S3
 * accepts it. A body that ends inside the first part is written with one PutObject instead.
 *
 * Kept apart from the reports adapter (report-s3.ts), whose artifacts are small enough to hold
 * whole; the S3 client is injectable so tests can run the part logic against a fake.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import type { CompletedPart } from "@aws-sdk/client-s3";

/** The storage operations an export needs. */
export interface MaintenanceS3Client {
  /** The object's bytes as a stream, or `null` when nothing is stored under the key. */
  open(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** Stores a body of unknown length without holding it in memory. Returns its length. */
  putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    options: { contentType: string; contentDisposition: string; partSizeBytes: number },
  ): Promise<number>;
}

const MIB = 1024 * 1024;
/** S3 and R2 refuse a non-final part under 5 MiB. */
export const MIN_PART_SIZE_BYTES = 8 * MIB;
/** S3 and R2 accept at most 10,000 parts. */
export const MAX_PARTS = 10_000;
/** Room in the archive for the data files, on top of the stored files' recorded sizes. */
const DATA_ALLOWANCE_BYTES = 8 * 1024 * MIB;

/**
 * A part size that fits an archive of about `expectedFileBytes` of stored files (plus the data) in
 * well under MAX_PARTS parts. The worker holds one part in memory, so this is also its buffer:
 * 8 MiB up to about 70 GiB of files, then growing with them.
 */
export function exportPartSize(expectedFileBytes: number): number {
  const needed = Math.ceil(((expectedFileBytes + DATA_ALLOWANCE_BYTES) * 1.25) / MAX_PARTS);
  return Math.max(MIN_PART_SIZE_BYTES, Math.ceil(needed / MIB) * MIB);
}

/** The few S3 client calls this adapter makes; the real S3Client satisfies it. */
export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === "NoSuchKey" || named.$metadata?.httpStatusCode === 404;
}

function asAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    return body as AsyncIterable<Uint8Array>;
  }
  const web = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (typeof web.transformToWebStream === "function") {
    return web.transformToWebStream() as unknown as AsyncIterable<Uint8Array>;
  }
  throw new Error("Unsupported object body stream");
}

export function createMaintenanceS3(options: {
  region?: string;
  endpoint?: string;
  bucket: string;
  /** Tests pass a fake; production builds an S3Client from region/endpoint. */
  client?: S3Sender;
}): MaintenanceS3Client {
  const client: S3Sender =
    options.client ??
    new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    });
  const Bucket = options.bucket;

  return {
    async open(key) {
      try {
        const response = (await client.send(new GetObjectCommand({ Bucket, Key: key }))) as {
          Body?: unknown;
        };
        return response.Body ? asAsyncIterable(response.Body) : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async putStream(key, body, { contentType, contentDisposition, partSizeBytes }) {
      const buffer = new Uint8Array(partSizeBytes);
      let filled = 0;
      let total = 0;
      let uploadId: string | undefined;
      const parts: CompletedPart[] = [];

      const flushPart = async () => {
        if (!uploadId) {
          const created = (await client.send(
            new CreateMultipartUploadCommand({
              Bucket,
              Key: key,
              ContentType: contentType,
              ContentDisposition: contentDisposition,
            }),
          )) as { UploadId?: string };
          if (!created.UploadId) throw new Error("Multipart upload was not created");
          uploadId = created.UploadId;
        }
        const PartNumber = parts.length + 1;
        if (PartNumber > MAX_PARTS) {
          throw new Error(
            `Export archive is larger than ${MAX_PARTS} parts of ${partSizeBytes} bytes`,
          );
        }
        // Awaited before the buffer is refilled, so the request never sees it change.
        const uploaded = (await client.send(
          new UploadPartCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber,
            Body: buffer.subarray(0, filled),
          }),
        )) as { ETag?: string };
        parts.push({ ETag: uploaded.ETag, PartNumber });
        filled = 0;
      };

      try {
        for await (const chunk of body) {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const take = Math.min(partSizeBytes - filled, chunk.byteLength - offset);
            buffer.set(chunk.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            total += take;
            if (filled === partSizeBytes) await flushPart();
          }
        }

        if (!uploadId) {
          await client.send(
            new PutObjectCommand({
              Bucket,
              Key: key,
              Body: buffer.subarray(0, filled),
              ContentType: contentType,
              ContentDisposition: contentDisposition,
            }),
          );
          return total;
        }
        if (filled > 0) await flushPart();
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
        return total;
      } catch (error) {
        if (uploadId) {
          // Best effort: R2 also aborts an upload left incomplete after 7 days by default.
          await client
            .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
            .catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
