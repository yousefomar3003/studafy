// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApiClient } from "./client";
import { ApiError } from "./errors";

const REQUEST_ID = "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12";

/** A fetch stand-in that always answers with a freshly-built response, so each call reads clean. */
function mockFetch(makeResponse: () => Response): typeof globalThis.fetch {
  return (async (_input: Request | string | URL, _init?: RequestInit) =>
    makeResponse()) as typeof globalThis.fetch;
}

function problemResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

describe("problem+json rejection through the client", () => {
  test("a 404 rejects with a typed ApiError exposing detail, instance, request_id, code, status", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: mockFetch(() =>
        problemResponse(
          404,
          {
            type: "about:blank",
            title: "Not Found",
            status: 404,
            detail: "The requested path /healthz does not exist.",
            instance: "/healthz",
            code: "RESOURCE_NOT_FOUND",
            request_id: REQUEST_ID,
          },
          { "x-request-id": REQUEST_ID },
        ),
      ),
    });

    // The generated client rejects (the problem+json middleware throws) rather than returning { error }.
    const caught = await client.GET("/healthz").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.status).toBe(404);
    expect(error.code).toBe("RESOURCE_NOT_FOUND");
    expect(error.detail).toBe("The requested path /healthz does not exist.");
    expect(error.instance).toBe("/healthz");
    expect(error.request_id).toBe(REQUEST_ID);
    // request_id rides along in the message so an uncaught throw is still correlatable in logs.
    expect(error.message).toContain(REQUEST_ID);
  });

  test("a 422 rejects with a typed ApiError a UI error boundary can read", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: mockFetch(() =>
        problemResponse(422, {
          type: "about:blank",
          title: "Unprocessable Entity",
          status: 422,
          detail: "event_id is required.",
          instance: "/erpnext/webhooks",
          code: "VALIDATION_FAILED",
          request_id: REQUEST_ID,
        }),
      ),
    });

    const caught = await client.GET("/readyz").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.status).toBe(422);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.detail).toBe("event_id is required.");
    expect(error.instance).toBe("/erpnext/webhooks");
    expect(error.request_id).toBe(REQUEST_ID);
  });
});

describe("ApiError.fromResponse", () => {
  test("falls back to the X-Request-Id header when the body omits request_id", async () => {
    const response = new Response(
      JSON.stringify({ title: "Bad Request", status: 400, code: "VALIDATION_FAILED" }),
      {
        status: 400,
        headers: { "content-type": "application/problem+json", "x-request-id": REQUEST_ID },
      },
    );

    const error = await ApiError.fromResponse(response);

    expect(error.request_id).toBe(REQUEST_ID);
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  test("a 5xx problem carries request_id even though it has no detail", async () => {
    const response = new Response(
      JSON.stringify({
        title: "Internal Server Error",
        status: 500,
        code: "INTERNAL_ERROR",
        request_id: REQUEST_ID,
      }),
      { status: 500, headers: { "content-type": "application/problem+json" } },
    );

    const error = await ApiError.fromResponse(response);

    expect(error.status).toBe(500);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.detail).toBeNull();
    expect(error.request_id).toBe(REQUEST_ID);
  });

  test("a non-problem error body degrades to a generic ApiError without inventing fields", async () => {
    const response = new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html", "x-request-id": REQUEST_ID },
    });

    const error = await ApiError.fromResponse(response);

    expect(error.status).toBe(502);
    expect(error.code).toBeNull();
    expect(error.detail).toBeNull();
    expect(error.problem).toBeNull();
    // The correlation header is still surfaced even when the body is unparseable.
    expect(error.request_id).toBe(REQUEST_ID);
  });
});
