/**
 * CSRF middleware integration tests (ST-067).
 *
 * Covers the double-submit cookie mechanism, the Bearer-token exemption for mobile/API clients,
 * and the RFC 9457 problem+json rejection envelope.
 *
 * Two app fixtures are used on purpose:
 *
 * - `buildApp()` — the real production stack, so status/header/envelope assertions are made
 *   against the middleware order the service actually boots with.
 * - `createProbeApp()` — the same middleware plus one echo route. The service has no /api mutation
 *   routes yet, so against the real app a request that *passes* CSRF lands on the 404 handler, and
 *   "not 403" is weak evidence of pass-through. The probe route lets the exemption tests assert a
 *   handler genuinely ran.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { errorHandlerMiddleware, requestIdMiddleware } from "../../src/middleware";
import { csrfMiddleware } from "../../src/middleware/csrf";

import type { AppEnv } from "../../src/middleware";

const logger = createLogger({ destination: () => undefined });
const tracker = createInflightTracker();

const CSRF_COOKIE = "XSRF-TOKEN";
const CSRF_HEADER = "X-XSRF-TOKEN";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A syntactically valid token, shaped like the ones generateCsrfToken emits (32 bytes, base64url). */
const VALID_TOKEN = "dGVzdC10b2tlbi0zMi1ieXRlcy1sb25nLXBhZGRpbmc";

function buildApp() {
  return createApp({ isReady: () => true, tracker, logger });
}

/** Minimal stack carrying a real /api mutation route, so pass-through is observable. */
function createProbeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware({ logger }));
  app.use("/api/*", csrfMiddleware());
  app.post("/api/echo", (c) => c.json({ handled: true }));
  app.onError(errorHandlerMiddleware(logger));
  return app;
}

/** Read one cookie's value out of the response's Set-Cookie headers. */
function readCookie(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.split("=")[1];
}

describe("CSRF middleware", () => {
  beforeEach(resetSecurityConfig);
  afterEach(resetSecurityConfig);

  describe("token issuance", () => {
    it("issues a JS-readable, SameSite=Strict token cookie on a safe /api request", async () => {
      const res = await buildApp().request("http://localhost/api/anything");

      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${CSRF_COOKIE}=`));
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      // The double-submit pattern requires the client to READ this cookie, so HttpOnly must be
      // absent. Set-Cookie has no "HttpOnly=false" form -- the flag is present or it is not.
      expect(setCookie).not.toContain("HttpOnly");
    });

    it("issues a distinct token per bootstrapping client", async () => {
      const app = buildApp();
      const first = readCookie(await app.request("http://localhost/api/a"), CSRF_COOKIE);
      const second = readCookie(await app.request("http://localhost/api/b"), CSRF_COOKIE);

      expect(first).toBeDefined();
      expect(first).not.toBe(second);
    });

    it("does not re-issue a token to a client that already holds one", async () => {
      const res = await buildApp().request("http://localhost/api/anything", {
        headers: { Cookie: `${CSRF_COOKIE}=${VALID_TOKEN}` },
      });

      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(false);
    });
  });

  describe("cookie-based CSRF breach vector", () => {
    it("rejects a mutation carrying cookies but no CSRF header, in problem+json", async () => {
      const res = await buildApp().request("http://localhost/api/anything", {
        method: "POST",
        headers: { Cookie: `session=abc; ${CSRF_COOKIE}=${VALID_TOKEN}` },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/problem+json");

      const problem = (await res.json()) as Record<string, unknown>;
      expect(problem.status).toBe(403);
      expect(problem.request_id).toMatch(UUID_PATTERN);
      // The id in the body must be the one stamped on the response, or a report links to nothing.
      expect(problem.request_id).toBe(res.headers.get("X-Request-Id"));
    });

    it("rejects a mutation whose header token does not match the cookie token", async () => {
      const res = await buildApp().request("http://localhost/api/anything", {
        method: "POST",
        headers: {
          Cookie: `${CSRF_COOKIE}=${VALID_TOKEN}`,
          [CSRF_HEADER]: "ZGlmZmVyZW50LXRva2VuLTMyLWJ5dGVzLWxvbmctcGFk",
        },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    });

    it("rejects a mutation carrying a header but no cookie", async () => {
      const res = await buildApp().request("http://localhost/api/anything", {
        method: "POST",
        headers: { [CSRF_HEADER]: VALID_TOKEN },
      });

      expect(res.status).toBe(403);
    });

    it("gates every state-mutating method and no safe one", async () => {
      const app = buildApp();

      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await app.request("http://localhost/api/anything", {
          method,
          headers: { Cookie: `${CSRF_COOKIE}=${VALID_TOKEN}` },
        });
        expect(res.status).toBe(403);
      }

      for (const method of ["GET", "HEAD"]) {
        const res = await app.request("http://localhost/api/anything", { method });
        expect(res.status).not.toBe(403);
      }
    });

    it("accepts a mutation whose header token matches the cookie token", async () => {
      const res = await createProbeApp().request("http://localhost/api/echo", {
        method: "POST",
        headers: { Cookie: `${CSRF_COOKIE}=${VALID_TOKEN}`, [CSRF_HEADER]: VALID_TOKEN },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: true });
    });
  });

  describe("mobile Bearer exemption", () => {
    it("passes a Bearer mutation through with no cookie and no CSRF header", async () => {
      const res = await createProbeApp().request("http://localhost/api/echo", {
        method: "POST",
        headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.test.signature" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: true });
    });

    it("exempts a Bearer caller even when it also sends cookies", async () => {
      // A mobile webview may carry cookies incidentally; the Bearer header still decides.
      const res = await createProbeApp().request("http://localhost/api/echo", {
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          Cookie: `session=abc; ${CSRF_COOKIE}=${VALID_TOKEN}`,
        },
      });

      expect(res.status).toBe(200);
    });

    it("does not treat a non-Bearer Authorization scheme as exempt", async () => {
      const res = await buildApp().request("http://localhost/api/anything", {
        method: "POST",
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("security event logging", () => {
    // This is where a CSRF violation is recorded. It is deliberately a log line and not an
    // audit_logs row: emitAuditLog resolves identity from the tenant GUCs that withTenantTx sets,
    // and a rejected unauthenticated request has none to offer. See "Known gaps" in
    // docs/security/web_defense_matrix.md.
    it("logs a structured violation carrying the reason and the tracing request_id", async () => {
      const lines: string[] = [];
      const capturing = createLogger({ destination: (line) => lines.push(line) });
      const app = createApp({ isReady: () => true, tracker, logger: capturing });

      const res = await app.request("http://localhost/api/anything", {
        method: "POST",
        headers: {
          Cookie: `${CSRF_COOKIE}=${VALID_TOKEN}`,
          [CSRF_HEADER]: "bWlzbWF0Y2hlZC10b2tlbi0zMi1ieXRlcy1sb25nLXg",
          "User-Agent": "probe/1.0",
          "X-Forwarded-For": "203.0.113.7",
        },
      });

      const violation = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.msg === "csrf validation failed");

      expect(violation).toBeDefined();
      expect(violation?.reason).toBe("token_mismatch");
      expect(violation?.method).toBe("POST");
      expect(violation?.client_ip).toBe("203.0.113.7");
      expect(violation?.user_agent).toBe("probe/1.0");
      expect(violation?.request_id).toBe(res.headers.get("X-Request-Id"));
    });

    it("never logs the token values themselves", async () => {
      const lines: string[] = [];
      const capturing = createLogger({ destination: (line) => lines.push(line) });

      await createApp({ isReady: () => true, tracker, logger: capturing }).request(
        "http://localhost/api/anything",
        { method: "POST", headers: { Cookie: `${CSRF_COOKIE}=${VALID_TOKEN}` } },
      );

      expect(lines.join("\n")).not.toContain(VALID_TOKEN);
    });
  });

  describe("exempt paths", () => {
    it("does not gate the ERPNext webhook, which authenticates by HMAC rather than a cookie", async () => {
      const res = await buildApp().request("http://localhost/api/webhooks/erpnext", {
        method: "POST",
      });

      expect(res.status).not.toBe(403);
    });

    it("does not gate health probes", async () => {
      const app = buildApp();

      for (const path of ["/healthz", "/readyz"]) {
        const res = await app.request(`http://localhost${path}`, { method: "POST" });
        expect(res.status).not.toBe(403);
      }
    });
  });
});
