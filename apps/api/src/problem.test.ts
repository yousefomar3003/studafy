// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createApp } from "./app";
import { createInflightTracker } from "./lifecycle";
import { createLogger } from "./logger";
import { apiProblemSchema } from "./problem";

import type { AppEnv } from "./request-context";

const buildApp = (routes: (app: Hono<AppEnv>) => void) => {
  const lines: string[] = [];
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: (line) => lines.push(line) }),
  });
  routes(app);
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
    // Exactly this, with no charset parameter: RFC 9457 defines none.
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
    // apiProblemSchema is the contract. It is deliberately not parsed in production — onError runs
    // inside Hono's catch, so a throw there would re-enter onError — which makes this the oracle.
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
    // The split that makes the bare body acceptable: the operator loses nothing, and request_id is
    // the handle that joins this line to the client's copy.
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
    // Also the guard for a silent dependency hazard: if apps/api and @studafy/shared-schemas ever
    // stop resolving to one copy of zod, `error instanceof ZodError` quietly stops matching and
    // every validation error becomes a 500. This test is what fails when that happens.
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

describe("log injection through the error path", () => {
  test("a newline-laden error message cannot forge a log record", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/x", () => {
        throw new Error('boom\n{"level":30,"msg":"FORGED"}');
      }),
    );

    await app.request("/x");

    // An error message is attacker-reachable wherever it echoes input, so it gets the same
    // guarantee as any other field.
    expect(lines.every((line) => line.slice(0, -1).split("\n").length === 1)).toBe(true);
    expect(lines.join("")).not.toInclude('\n{"level":30,"msg":"FORGED"}');
    expect(failureLog(lines).level).toBe(50);
  });
});
