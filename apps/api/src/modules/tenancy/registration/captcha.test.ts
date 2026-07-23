/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test, mock } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { verifyCaptcha } from "./captcha";

describe("captcha", () => {
  test("returns true when secretKey is undefined (dev mode)", async () => {
    const result = await verifyCaptcha("some-token", undefined);
    expect(result).toBe(true);
  });

  test("returns true when secretKey is empty string (dev mode)", async () => {
    const result = await verifyCaptcha("some-token", "");
    expect(result).toBe(true);
  });

  test("returns false when fetch throws", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network error")),
    ) as unknown as typeof fetch;
    try {
      const result = await verifyCaptcha("bad-token", "test-secret");
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns false when response is not ok", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    ) as unknown as typeof fetch;
    try {
      const result = await verifyCaptcha("token", "test-secret");
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns false when success is false in response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    ) as unknown as typeof fetch;
    try {
      const result = await verifyCaptcha("bad-token", "test-secret");
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns true when success is true in response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    try {
      const result = await verifyCaptcha("valid-token", "test-secret");
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
