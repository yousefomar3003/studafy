// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { createApp } from "./app";
import { createInflightTracker } from "./lifecycle";
import { createLogger } from "./logger";

import type { AppEnv } from "./request-context";

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

const records = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const completion = (lines: string[]): Record<string, unknown> =>
  records(lines).find((record) => record.msg === "request completed")!;

describe("X-Request-Id header", () => {
  test("is a v4 uuid on a 200", async () => {
    const { app } = buildApp();

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
  });

  test("is present on a 503 from readiness", async () => {
    const app = createApp({
      isReady: () => false,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
    });

    const res = await app.request("/readyz");

    expect(res.status).toBe(503);
    expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
  });

  test("is present on an unmatched route", async () => {
    // app.use("*") matches even when no route does, so the 404 still unwinds through the stamp.
    const { app } = buildApp();

    const res = await app.request("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
  });

  test("is present on a 500 from a throwing handler", async () => {
    const { app } = buildApp((a) =>
      a.get("/boom", () => {
        throw new Error("boom");
      }),
    );

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
  });

  test("differs between requests", async () => {
    const { app } = buildApp();

    const first = await app.request("/healthz");
    const second = await app.request("/healthz");

    expect(first.headers.get("X-Request-Id")).not.toBe(second.headers.get("X-Request-Id"));
  });
});

describe("inbound X-Request-Id is not trusted", () => {
  test("a client-supplied id is ignored and replaced with a generated one", async () => {
    const { app } = buildApp();

    const res = await app.request("/healthz", {
      headers: { "X-Request-Id": "attacker-chosen-id" },
    });

    // Honouring this would let a caller choose the identifier for its own audit row.
    expect(res.headers.get("X-Request-Id")).not.toBe("attacker-chosen-id");
    expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
  });

  test("a client-supplied id never reaches the log line", async () => {
    const { app, lines } = buildApp();

    await app.request("/healthz", { headers: { "X-Request-Id": "attacker-chosen-id" } });

    expect(lines.join("")).not.toInclude("attacker-chosen-id");
    expect(completion(lines).request_id).toMatch(UUID_V4);
  });
});

describe("child logger context", () => {
  test("the logged request_id is the one returned to the client", async () => {
    // The correlation guarantee the whole ticket exists for: the header a client quotes in a bug
    // report is the exact value an operator greps for.
    const { app, lines } = buildApp();

    const res = await app.request("/healthz");

    expect(completion(lines).request_id).toBe(res.headers.get("X-Request-Id"));
  });

  test("binds method, path, and null tenant fields", async () => {
    const { app, lines } = buildApp();

    await app.request("/healthz");

    expect(completion(lines)).toMatchObject({
      method: "GET",
      path: "/healthz",
      // No authentication exists yet; null rather than absent, so a query can tell "unknown" from
      // "field missing".
      school_id: null,
      user_id: null,
      status: 200,
      msg: "request completed",
    });
    expect(completion(lines).duration_ms).toBeNumber();
  });

  test("logs the path without the query string", async () => {
    const { app, lines } = buildApp();

    await app.request("/healthz?token=super-secret&filter=pii");

    expect(completion(lines).path).toBe("/healthz");
    expect(lines.join("")).not.toInclude("super-secret");
  });

  test("the request logger is reachable from a handler and survives an await", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/deep", async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Context propagation across an async boundary: `c` is captured by the closure, so it is
        // still the right request's logger on the far side of the await.
        c.get("log").info("from inside a handler");
        return c.json({ ok: true });
      }),
    );

    const res = await app.request("/deep");

    const inner = records(lines).find((record) => record.msg === "from inside a handler")!;
    expect(inner.request_id).toBe(res.headers.get("X-Request-Id"));
    expect(inner.path).toBe("/deep");
  });

  test("concurrent requests do not share context", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/slow/:id", async (c) => {
        await new Promise((resolve) => setTimeout(resolve, Number(c.req.param("id"))));
        c.get("log").info("inner");
        return c.json({ ok: true });
      }),
    );

    const [slow, fast] = await Promise.all([app.request("/slow/20"), app.request("/slow/1")]);

    const inner = records(lines).filter((record) => record.msg === "inner");
    const ids = new Set(inner.map((record) => record.request_id));
    expect(ids.size).toBe(2);
    expect(ids).toContain(slow.headers.get("X-Request-Id"));
    expect(ids).toContain(fast.headers.get("X-Request-Id"));
  });

  test("a downstream middleware can re-child the logger with an identity", async () => {
    // The seam a future auth middleware uses. It runs inside requestContext, so it cannot be read
    // on the way in — it overrides on the way through by re-childing.
    const { app, lines } = buildApp((a) => {
      a.use("/tenant", async (c, next) => {
        c.set("log", c.get("log").child({ school_id: "school-1", user_id: "user-1" }));
        await next();
      });
      a.get("/tenant", (c) => c.json({ ok: true }));
    });

    await app.request("/tenant");

    expect(completion(lines)).toMatchObject({ school_id: "school-1", user_id: "user-1" });
  });
});

describe("completion logging", () => {
  test("logs the mapped status for a failed request", async () => {
    const { app, lines } = buildApp((a) =>
      a.get("/forbidden", () => {
        throw new HTTPException(403, { message: "nope" });
      }),
    );

    await app.request("/forbidden");

    expect(completion(lines).status).toBe(403);
  });

  test("emits exactly one completion line per request", async () => {
    const { app, lines } = buildApp();

    await app.request("/healthz");

    expect(records(lines).filter((record) => record.msg === "request completed")).toHaveLength(1);
  });
});
