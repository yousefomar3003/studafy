import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  MAX_PARTS,
  MIN_PART_SIZE_BYTES,
  createMaintenanceS3,
  exportPartSize,
} from "./export-storage";

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

function fakeClient(options: { failPart?: number; getError?: unknown } = {}) {
  const sent: Sent[] = [];
  return {
    sent,
    async send(command: unknown) {
      const { input } = command as { input: Record<string, unknown> };
      // The part body is a view of a buffer the adapter reuses: copy it as the network would.
      const body = input.Body instanceof Uint8Array ? new Uint8Array(input.Body) : input.Body;
      const name = (command as object).constructor.name;
      sent.push({ name, input: { ...input, Body: body } });
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
      if (command instanceof UploadPartCommand) {
        if (input.PartNumber === options.failPart) throw new Error("part failed");
        return { ETag: `"etag-${String(input.PartNumber)}"` };
      }
      if (command instanceof GetObjectCommand) {
        if (options.getError) throw options.getError;
        return {
          Body: (async function* () {
            yield new Uint8Array([1, 2]);
          })(),
        };
      }
      return {};
    },
  };
}

async function* chunks(...sizes: number[]) {
  let value = 0;
  for (const size of sizes) {
    yield new Uint8Array(size).map(() => value++ % 256);
  }
}

const OPTIONS = { contentType: "application/zip", contentDisposition: "attachment" };

describe("exportPartSize", () => {
  test("is 8 MiB until the files outgrow it, then keeps the archive under the part limit", () => {
    expect(exportPartSize(0)).toBe(MIN_PART_SIZE_BYTES);
    expect(exportPartSize(50 * 1024 ** 3)).toBe(MIN_PART_SIZE_BYTES);
    const files = 500 * 1024 ** 3;
    const part = exportPartSize(files);
    expect(part % (1024 * 1024)).toBe(0);
    expect(part * MAX_PARTS).toBeGreaterThan(files * 1.2);
  });
});

describe("createMaintenanceS3", () => {
  test("a body that fits in one part is written with one PutObject", async () => {
    const client = fakeClient();
    const s3 = createMaintenanceS3({ bucket: "b", client });
    const length = await s3.putStream("k", chunks(3, 4), { ...OPTIONS, partSizeBytes: 16 });
    expect(length).toBe(7);
    expect(client.sent.map((call) => call.name)).toEqual([PutObjectCommand.name]);
    expect(client.sent[0]!.input).toMatchObject({
      Bucket: "b",
      Key: "k",
      ContentType: "application/zip",
      ContentDisposition: "attachment",
    });
    expect((client.sent[0]!.input.Body as Uint8Array).byteLength).toBe(7);
  });

  test("a longer body is uploaded in equal parts but the last, in order", async () => {
    const client = fakeClient();
    const s3 = createMaintenanceS3({ bucket: "b", client });
    const length = await s3.putStream("k", chunks(5, 11, 9), { ...OPTIONS, partSizeBytes: 8 });
    expect(length).toBe(25);
    expect(client.sent.map((call) => call.name)).toEqual([
      CreateMultipartUploadCommand.name,
      UploadPartCommand.name,
      UploadPartCommand.name,
      UploadPartCommand.name,
      UploadPartCommand.name,
      CompleteMultipartUploadCommand.name,
    ]);
    const parts = client.sent.filter((call) => call.name === UploadPartCommand.name);
    expect(parts.map((call) => (call.input.Body as Uint8Array).byteLength)).toEqual([8, 8, 8, 1]);
    const joined = Buffer.concat(parts.map((call) => call.input.Body as Uint8Array));
    expect([...joined]).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(client.sent.at(-1)!.input.MultipartUpload).toEqual({
      Parts: [1, 2, 3, 4].map((PartNumber) => ({ ETag: `"etag-${PartNumber}"`, PartNumber })),
    });
    expect(client.sent[0]!.input.ContentDisposition).toBe("attachment");
  });

  test("a failure aborts the multipart upload instead of completing it", async () => {
    const client = fakeClient({ failPart: 2 });
    const s3 = createMaintenanceS3({ bucket: "b", client });
    await expect(s3.putStream("k", chunks(20), { ...OPTIONS, partSizeBytes: 8 })).rejects.toThrow(
      "part failed",
    );
    const names = client.sent.map((call) => call.name);
    expect(names).toContain(AbortMultipartUploadCommand.name);
    expect(names).not.toContain(CompleteMultipartUploadCommand.name);
  });

  test("a failing body aborts the upload too", async () => {
    const client = fakeClient();
    const s3 = createMaintenanceS3({ bucket: "b", client });
    async function* failing() {
      yield new Uint8Array(10);
      throw new Error("archive failed");
    }
    await expect(s3.putStream("k", failing(), { ...OPTIONS, partSizeBytes: 8 })).rejects.toThrow(
      "archive failed",
    );
    expect(client.sent.at(-1)!.name).toBe(AbortMultipartUploadCommand.name);
  });

  test("open streams an object, and answers null when there is none", async () => {
    const s3 = createMaintenanceS3({ bucket: "b", client: fakeClient() });
    const body = await s3.open("k");
    const read: number[] = [];
    for await (const chunk of body!) read.push(...chunk);
    expect(read).toEqual([1, 2]);

    const missing = createMaintenanceS3({
      bucket: "b",
      client: fakeClient({ getError: Object.assign(new Error("gone"), { name: "NoSuchKey" }) }),
    });
    expect(await missing.open("k")).toBeNull();

    const broken = createMaintenanceS3({
      bucket: "b",
      client: fakeClient({ getError: new Error("network") }),
    });
    await expect(broken.open("k")).rejects.toThrow("network");
  });
});
