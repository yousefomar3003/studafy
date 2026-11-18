/**
 * QA-054: the scanner's limits match what uploads may be, and what it cannot fully scan fails closed.
 *
 * The workers streamed at most 25 MiB to clamd (StreamMaxLength 26M) while a material may be
 * 100 MiB, so every large material ended `failed`. And clamd's defaults answer OK for an archive
 * member over its limits and for encrypted archives and PDFs, so those passed as clean.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const MIB = 1024 * 1024;

/** Every `maxSizeBytes: N * MIB` in the upload content classes, as bytes. */
function largestUploadBytes(): number {
  const sizes = [
    ...read("apps/api/src/modules/storage/content-classes.ts").matchAll(
      /maxSizeBytes:\s*(\d+)\s*\*\s*MIB/gu,
    ),
  ].map((match) => Number(match[1]) * MIB);
  expect(sizes.length).toBeGreaterThan(5);
  return Math.max(...sizes);
}

function workerScanLimitBytes(): number {
  const match = /CLAMAV_MAX_FILE_BYTES:[\s\S]*?\.default\((\d+)\s*\*\s*1024\s*\*\s*1024\)/u.exec(
    read("apps/workers/src/env.ts"),
  );
  return Number(match![1]) * MIB;
}

/** A clamd size directive from the image, in bytes. */
function clamdBytes(directive: string): number {
  const match = new RegExp(`'${directive} (\\d+)M'`, "u").exec(
    read("infra/docker/clamav.Dockerfile"),
  );
  expect(match).not.toBeNull();
  return Number(match![1]) * MIB;
}

describe("ClamAV limits (QA-054)", () => {
  test("the worker streams every upload class in full", () => {
    expect(workerScanLimitBytes()).toBeGreaterThanOrEqual(largestUploadBytes());
  });

  test("clamd accepts and scans everything the worker streams", () => {
    for (const directive of ["StreamMaxLength", "MaxScanSize", "MaxFileSize"]) {
      expect({ directive, bytes: clamdBytes(directive) }).toEqual({
        directive,
        bytes: expect.any(Number),
      });
      expect(clamdBytes(directive)).toBeGreaterThan(workerScanLimitBytes());
    }
  });

  test("what clamd cannot fully scan is reported, not passed", () => {
    const dockerfile = read("infra/docker/clamav.Dockerfile");
    for (const directive of ["AlertExceedsMax", "AlertEncryptedArchive", "AlertEncryptedDoc"]) {
      expect(dockerfile).toContain(`'${directive} yes'`);
    }
  });
});
