/**
 * QA-036: a presigned upload URL binds the size the client declared.
 *
 * The PUT used to sign only host (and content-type), so the URL accepted any body up to S3's 5 GB
 * limit: anyone could park 5 GB objects under temp/. Signing content-length makes the URL valid only
 * for a body of exactly the declared size, which the request-upload route has already checked
 * against the content class's cap. Signing is local, so this needs no bucket.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { createStorageService } from "./client";

import type { Env } from "../../env";

const storage = createStorageService({
  S3_APP_FILES_BUCKET: "bucket",
  S3_REGION: "auto",
  S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  S3_SECRET_ACCESS_KEY: "secret-example",
  S3_PRESIGN_TTL_SECONDS: 900,
} as unknown as Env)!;

describe("presigned PUT (QA-036)", () => {
  test("signs content-length when the size is known", async () => {
    const { url } = await storage.presign(
      "temp/s/o/file.pdf",
      "PUT",
      "application/pdf",
      undefined,
      {
        contentLength: 2048,
      },
    );
    const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";")).toContain("content-length");
  });

  test("a GET is unaffected", async () => {
    const { url } = await storage.presign("permanent/s/o/file.pdf", "GET");
    expect(new URL(url).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});
