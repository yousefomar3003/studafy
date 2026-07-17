import { createHmac } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { verifyWebhookSignature } from "./signature";

const SECRET = "test-webhook-secret";

function hmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  test("rejects when signature header is missing", () => {
    expect(verifyWebhookSignature("hello", null, SECRET)).toBe(false);
  });

  test("rejects when signature does not match", () => {
    expect(verifyWebhookSignature("hello", "deadbeef", SECRET)).toBe(false);
  });

  test("rejects when body has been tampered with", () => {
    const sig = hmac("hello", SECRET);
    expect(verifyWebhookSignature("hello!", sig, SECRET)).toBe(false);
  });

  test("rejects when secret is wrong", () => {
    const sig = hmac("hello", "wrong-secret");
    expect(verifyWebhookSignature("hello", sig, SECRET)).toBe(false);
  });

  test("rejects non-hex signature strings gracefully", () => {
    expect(verifyWebhookSignature("hello", "not-hex!", SECRET)).toBe(false);
  });
});
