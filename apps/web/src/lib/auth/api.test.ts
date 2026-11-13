import { ApiError } from "@studafy/api-client";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createAuthRefreshClient } from "./api";

import type { components } from "@studafy/api-client";

type TokenPair = components["schemas"]["TokenPair"];

/** Captures outbound Requests, answering `response`; the api-client test idiom. */
function capturingFetch(response: { status: number; body: unknown }) {
  const requests: Request[] = [];
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(request);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const tokenPair: TokenPair = {
  access_token: "at-web",
  token_type: "Bearer",
  expires_in: 900,
  session_id: "session-1",
};

describe("createAuthRefreshClient", () => {
  test("refresh is cookie-authenticated: credentials include, no body, no bearer header", async () => {
    const { fetch, requests } = capturingFetch({ status: 200, body: tokenPair });
    const client = createAuthRefreshClient({ fetch });

    await client.refresh();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toEndWith("/api/auth/refresh");
    expect(requests[0].credentials).toBe("include");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[0].body).toBeNull();
  });

  test("maps a token pair into in-memory session tokens", async () => {
    const { fetch } = capturingFetch({ status: 200, body: tokenPair });
    const client = createAuthRefreshClient({ fetch });

    const session = await client.refresh();

    expect(session.accessToken).toBe("at-web");
    expect(session.sessionId).toBe("session-1");
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + 901_000);
  });

  test("logout posts to the logout endpoint", async () => {
    const { fetch, requests } = capturingFetch({ status: 200, body: { ended: true } });
    const client = createAuthRefreshClient({ fetch });

    await client.logout();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toEndWith("/api/auth/logout");
  });

  test("a rejected credential surfaces as a typed ApiError for the store to map", async () => {
    const { fetch } = capturingFetch({
      status: 401,
      body: {
        type: "about:blank",
        title: "Invalid token",
        status: 401,
        code: "AUTH_TOKEN_INVALID",
        detail: "presented token was already rotated",
      },
    });
    const client = createAuthRefreshClient({ fetch });

    await expect(client.refresh()).rejects.toThrow(ApiError);
    await expect(client.refresh()).rejects.toMatchObject({ status: 401 });
  });
});
