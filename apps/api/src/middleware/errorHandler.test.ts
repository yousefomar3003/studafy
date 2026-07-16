// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createApp } from "../app";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import { apiProblemSchema } from "./errorHandler";

import type { AppEnv } from "./requestId";

/** RFC 4122 version 4, variant 1 — the shape crypto.randomUUID() produces. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const buildApp = (routes?: (app: Hono<AppEnv>) => void) => {
  const lines: string[] = [];
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: (line) => lines.push(line) }),
  });
  routes?.(app);
  return { app, lines };
};

const failureLog = (lines: string[]): Record<string, unknown> =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.msg === "request failed")!;

describe("problem+json envelope", () => {
  test("an HTTPException maps to its status with the canonical error code", async () => {
    const { app } = buildApp((a) =>
      a.get("/forbidden", () => {
        throw new HTTPException(403, { message: "not your school" });
      }),
    );

    const res = await app.request("/forbidden");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(body).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: "not your school",
      code: "AUTHZ_FORBIDDEN",
      request_id: res.headers.get("X-Request-Id"),
    });
  });

  test("every mapped status produces a body satisfying the shared schema", async () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500] as const) {
      const { app } = buildApp((a) =>
        a.get("/x", () => {
          throw new HTTPException(status, { message: "m" });
        }),
      );

      const body = await (await app.request("/x")).json();

      expect(apiProblemSchema.safeParse(body).success).toBe(true);
    }
  });

  test("the body request_id matches the X-Request-Id header", async () => {
    const { app } = buildApp((a) =>
      a.get("/boom", () => {
        throw new Error("boom");
      }),
    );

    const res = await app.request("/boom");
    const body = (await res.json()) as { request_id: string };

    expect(body.request_id).toBe(res.headers.get("X-Request-Id")!);
  });
});

describe("internal errors do not leak", () => {
  test("an unknown error yields a bare 500 carrying nothing from the error", async () => {
    const { app } = buildApp((a) =>
      a.get("/leak", () => {
        throw new Error("connection to db-primary.internal failed: password=hunter2");
      }),
    );

    const res = await app.request("/leak");
    const raw = await res.text();

    expect(res.status).toBe(500);
    expect(raw).not.toInclude("hunter2");
    expect(raw).not.toInclude("db-primary.internal");
    expect(raw).not.toInclude("stack");
    expect(JSON.parse(raw)).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
      request_id: res.headers.get("X-Request-Id"),
    });
  });

  test("the same error IS fully recorded on the log line", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/leak", () => {
        throw new Error("password=hunter2");
      }),
    );

    const res = await app.request("/leak");

    const record = failureLog(lines);
    expect(record.level).toBe(50);
    expect(record.request_id).toBe(res.headers.get("X-Request-Id")!);
    expect(record.err).toMatchObject({ type: "Error", message: "password=hunter2" });
    expect((record.err as { stack: string }).stack).toBeString();
  });

  test("a 5xx HTTPException message is withheld from the body but logged", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/x", () => {
        throw new HTTPException(500, { message: "upstream billing-svc timed out" });
      }),
    );

    const raw = await (await app.request("/x")).text();

    expect(raw).not.toInclude("billing-svc");
    expect(JSON.parse(raw).detail).toBeUndefined();
    expect(failureLog(lines).err).toMatchObject({ message: "upstream billing-svc timed out" });
  });

  test("a 4xx logs at warn, a 5xx at error", async () => {
    const { app: clientError, lines: clientLines } = buildApp((a) =>
      a.get("/x", () => {
        throw new HTTPException(404);
      }),
    );
    const { app: serverError, lines: serverLines } = buildApp((a) =>
      a.get("/x", () => {
        throw new Error("boom");
      }),
    );

    await clientError.request("/x");
    await serverError.request("/x");

    expect(failureLog(clientLines).level).toBe(40);
    expect(failureLog(serverLines).level).toBe(50);
  });
});

describe("validation errors", () => {
  test("a ZodError maps to 400 VALIDATION_FAILED with a detail", async () => {
    const { app } = buildApp((a) =>
      a.get("/validate", () => {
        z.object({ age: z.number() }).parse({ age: "not a number" });
        return new Response();
      }),
    );

    const res = await app.request("/validate");
    const body = (await res.json()) as { code: string; detail: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.detail).toInclude("age");
  });
});

describe("unmatched routes", () => {
  test("yield the problem+json envelope rather than Hono's text/plain 404", async () => {
    const { app } = buildApp();

    const res = await app.request("/v1/invalid-route-path");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(body).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Resource not found. The requested path /v1/invalid-route-path does not exist.",
      instance: "/v1/invalid-route-path",
      code: "RESOURCE_NOT_FOUND",
      request_id: res.headers.get("X-Request-Id"),
    });
  });

  test("carry a request id that is a v4 uuid and matches the body", async () => {
    const { app } = buildApp();

    const res = await app.request("/v1/invalid-route-path");
    const body = (await res.json()) as { request_id: string };

    expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
    expect(body.request_id).toBe(res.headers.get("X-Request-Id")!);
  });

  test("produce a body satisfying the shared schema", async () => {
    const { app } = buildApp();

    const body = await (await app.request("/v1/invalid-route-path")).json();

    expect(apiProblemSchema.safeParse(body).success).toBe(true);
  });

  test("a query string is never echoed into the body", async () => {
    const { app } = buildApp();

    const res = await app.request("/v1/invalid-route-path?token=super-secret&filter=pii");
    const raw = await res.text();

    expect(raw).not.toInclude("super-secret");
    expect(raw).not.toInclude("filter=pii");
    expect(JSON.parse(raw).instance).toBe("/v1/invalid-route-path");
  });

  test("a known path with an unrouted method gets the same envelope", async () => {
    const { app } = buildApp();

    const res = await app.request("/healthz", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(apiProblemSchema.safeParse(await res.json()).success).toBe(true);
  });

  test("emit no failure log line, only the completion line requestContext already writes", async () => {
    const { app, lines } = buildApp();

    await app.request("/v1/invalid-route-path");

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.msg === "request failed")).toBeEmpty();
    const completed = records.filter((record) => record.msg === "request completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: 404, path: "/v1/invalid-route-path" });
  });
});

describe("log injection through the error path", () => {
  test("a newline-laden error message cannot forge a log record", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/x", () => {
        throw new Error('boom\n{"level":30,"msg":"FORGED"}');
      }),
    );

    await app.request("/x");

    expect(lines.every((line) => line.slice(0, -1).split("\n").length === 1)).toBe(true);
    expect(lines.join("")).not.toInclude('\n{"level":30,"msg":"FORGED"}');
    expect(failureLog(lines).level).toBe(50);
  });
});

describe("locale-aware error messages", () => {
  test("returns English error message for Accept-Language: en", async () => {
    const { app } = buildApp((a) =>
      a.get("/auth-error", () => {
        throw new HTTPException(401, { message: "Invalid credentials" });
      }),
    );

    const res = await app.request("/auth-error", {
      headers: { "Accept-Language": "en" },
    });
    const body = (await res.json()) as { detail: string; code: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("AUTH_TOKEN_INVALID");
    expect(body.detail).toBe("Invalid credentials");
  });

  test("500 errors do not expose detail to the client", async () => {
    const { app } = buildApp((a) =>
      a.get("/unknown-error", () => {
        throw new Error("Unknown error");
      }),
    );

    const res = await app.request("/unknown-error", {
      headers: { "Accept-Language": "ar" },
    });
    const body = (await res.json()) as { detail: string; code: string };

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.detail).toBeUndefined();
  });

  test("500 errors do not expose detail even with Accept-Language: en", async () => {
    const { app } = buildApp((a) =>
      a.get("/unknown-error", () => {
        throw new Error("Unknown error");
      }),
    );

    const res = await app.request("/unknown-error", {
      headers: { "Accept-Language": "en" },
    });
    const body = (await res.json()) as { detail: string; code: string };

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.detail).toBeUndefined();
  });

  test("returns Arabic 404 message when Accept-Language is ar", async () => {
    const { app } = buildApp();

    const res = await app.request("/nonexistent", {
      headers: { "Accept-Language": "ar" },
    });
    const body = (await res.json()) as { detail: string; code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.detail).toContain("لم يتم العثور على المورد");
  });

  test("returns English 404 message when Accept-Language is en", async () => {
    const { app } = buildApp();

    const res = await app.request("/nonexistent", {
      headers: { "Accept-Language": "en" },
    });
    const body = (await res.json()) as { detail: string; code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.detail).toContain("Resource not found");
  });
});
