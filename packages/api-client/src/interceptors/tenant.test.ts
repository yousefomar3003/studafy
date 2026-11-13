// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApiClient } from "../client";

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

describe("tenantMiddleware (via the client)", () => {
  test("injects the active school_id as a query parameter", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({
      baseUrl: "http://api.test",
      getSchoolId: () => "school-abc",
      fetch,
    });

    await client.GET("/healthz");

    expect(new URL(last()!.url).searchParams.get("school_id")).toBe("school-abc");
  });

  test("does not inject when no tenant is selected", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({ baseUrl: "http://api.test", getSchoolId: () => null, fetch });

    await client.GET("/healthz");

    expect(new URL(last()!.url).searchParams.has("school_id")).toBe(false);
  });

  test("does not duplicate the tenant when the path already carries it", async () => {
    const { fetch, last } = capturingFetch();
    // A future /{school_id}/… route substitutes the id into the path; the middleware must not also
    // append a redundant query parameter. Simulated here with a baseUrl that already contains the id.
    const client = createApiClient({
      baseUrl: "http://api.test/school-abc",
      getSchoolId: () => "school-abc",
      fetch,
    });

    await client.GET("/healthz");

    expect(new URL(last()!.url).searchParams.has("school_id")).toBe(false);
  });
});
