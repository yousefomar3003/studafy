// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  createTokenBucket,
  DEFAULT_LIMITS,
  isBareOrigin,
  isOriginAllowed,
  MAX_PAYLOAD_BYTES,
} from "./limits";

describe("limits (F-16)", () => {
  test("frames are capped at 16 KB or less", () => {
    expect(MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(16 * 1024);
  });

  test("the default room cap leaves room for the three home rooms", () => {
    expect(DEFAULT_LIMITS.maxRoomsPerSocket).toBeGreaterThanOrEqual(3);
  });
});

describe("createTokenBucket", () => {
  test("allows a burst of `capacity`, then refuses until it refills", () => {
    let now = 0;
    const bucket = createTokenBucket(3, 1, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true]);
    expect(bucket.take()).toBe(false);

    now += 999;
    expect(bucket.take()).toBe(false);
    now += 1;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  test("never refills past capacity", () => {
    let now = 0;
    const bucket = createTokenBucket(2, 10, () => now);
    now += 60_000;
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
  });
});

describe("isOriginAllowed", () => {
  const allowlist = ["https://app.studafy.com"];

  test("allows a listed origin", () => {
    expect(isOriginAllowed("https://app.studafy.com", allowlist)).toBe(true);
  });

  test.each(["https://evil.example", "http://app.studafy.com", "https://app.studafy.com.evil.io"])(
    "refuses an unlisted origin (%s)",
    (origin) => {
      expect(isOriginAllowed(origin, allowlist)).toBe(false);
    },
  );

  test("lets a request with no Origin header through (non-browser clients)", () => {
    expect(isOriginAllowed(undefined, allowlist)).toBe(true);
  });

  test("an empty allowlist turns the check off", () => {
    expect(isOriginAllowed("https://anything.example", [])).toBe(true);
  });
});

describe("isBareOrigin", () => {
  test.each([
    ["https://app.studafy.com", true],
    ["http://localhost:5180", true],
    ["https://app.studafy.com/", false],
    ["https://app.studafy.com/path", false],
    ["https://*.studafy.com", false],
    ["app.studafy.com", false],
  ])("%s → %p", (value, expected) => {
    expect(isBareOrigin(value)).toBe(expected);
  });
});
