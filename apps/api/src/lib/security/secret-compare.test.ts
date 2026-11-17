/**
 * QA-092: shared secrets are compared in constant time.
 *
 * POST /api/finance/reconciliation/run checked X-Api-Key with `!==`, which stops at the first
 * differing character and so leaks, to a patient caller, how much of a guess is right. Secrets are
 * now compared as SHA-256 digests with crypto.timingSafeEqual: equal-length inputs to the
 * comparison, so neither content nor length shows in the timing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../../app";
import { createUnusableDatabase } from "../../db/unusable";
import { createInflightTracker } from "../../lifecycle";
import { createLogger } from "../../logger";

import { secretsMatch } from "./secret-compare";

describe("secretsMatch (QA-092)", () => {
  test("matches only the exact secret", () => {
    expect(secretsMatch("s3cret-key", "s3cret-key")).toBe(true);
    expect(secretsMatch("s3cret-kez", "s3cret-key")).toBe(false);
    expect(secretsMatch("short", "s3cret-key")).toBe(false);
    expect(secretsMatch(undefined, "s3cret-key")).toBe(false);
    expect(secretsMatch("anything", undefined)).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
  });

  test("the reconciliation trigger uses it, not a string comparison", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../modules/finance/jobs/reconciliation.routes.ts"),
      "utf8",
    );
    expect(source).toContain("secretsMatch(");
    expect(source).not.toMatch(/apiKey\s*!==\s*expectedKey/);
  });
});

describe("POST /api/finance/reconciliation/run key check (QA-092)", () => {
  const KEY = "reconciliation-test-key-0123456789";
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.RECONCILIATION_API_KEY;
    process.env.RECONCILIATION_API_KEY = KEY;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.RECONCILIATION_API_KEY;
    else process.env.RECONCILIATION_API_KEY = previous;
  });

  const run = (key?: string) =>
    createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      database: createUnusableDatabase(),
    }).request("/api/finance/reconciliation/run", {
      method: "POST",
      headers: key === undefined ? {} : { "X-Api-Key": key },
    });

  test("a wrong key of the same length and of a different length both get 403", async () => {
    expect((await run(KEY.slice(0, -1) + "X")).status).toBe(403);
    expect((await run("short")).status).toBe(403);
    expect((await run()).status).toBe(403);
  });

  test("the right key gets past authentication", async () => {
    // The unusable database then fails the run: anything but 403 means the key was accepted.
    expect((await run(KEY)).status).not.toBe(403);
  });
});
