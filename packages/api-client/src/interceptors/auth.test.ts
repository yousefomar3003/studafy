// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApiClient } from "../client";

/** Captures the outbound Request openapi-fetch hands to `fetch`, then answers 200. */
function capturingFetch(): { fetch: typeof globalThis.fetch; last: () => Request | undefined } {
  let captured: Request | undefined;
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    captured = input instanceof Request ? input : new Request(String(input), init);
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, last: () => captured };
}

describe("authMiddleware (via the client)", () => {
  test("injects Authorization: Bearer when a token is available", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => "tok-123",
      fetch,
    });

    await client.GET("/healthz");

    expect(last()?.headers.get("authorization")).toBe("Bearer tok-123");
  });

  test("awaits an async token provider", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: async () => "async-tok",
      fetch,
    });

    await client.GET("/healthz");

    expect(last()?.headers.get("authorization")).toBe("Bearer async-tok");
  });

  test("leaves the request anonymous when no token is available", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({ baseUrl: "http://api.test", getToken: () => null, fetch });

    await client.GET("/healthz");

    expect(last()?.headers.get("authorization")).toBeNull();
  });
});
