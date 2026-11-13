/**
 * Security headers integration tests (ST-067).
 *
 * Asserts the response header matrix documented in docs/security/web_defense_matrix.md. The
 * assertions are on exact values rather than mere presence: a header whose value has silently
 * weakened (`X-Frame-Options: SAMEORIGIN`, a short HSTS max-age, `unsafe-inline` creeping into
 * script-src) still passes a presence check while no longer defending anything.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { securityHeadersMiddleware } from "../../src/middleware/securityHeaders";

const logger = createLogger({ destination: () => undefined });
const tracker = createInflightTracker();

function buildApp() {
  return createApp({ isReady: () => true, tracker, logger });
}

/**
 * The CSP header name depends on environment: development serves Report-Only so a new directive
 * cannot break local work before anyone has seen the violation.
 */
function readCsp(res: Response): string | null {
  return (
    res.headers.get("Content-Security-Policy") ??
    res.headers.get("Content-Security-Policy-Report-Only")
  );
}

describe("security headers", () => {
  beforeEach(resetSecurityConfig);
  afterEach(resetSecurityConfig);

  describe("header matrix", () => {
    it("sets the full matrix on a normal response", async () => {
      const res = await buildApp().request("http://localhost/healthz");

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-site");
      expect(res.headers.get("Permissions-Policy")).toContain("geolocation=()");
      expect(readCsp(res)).toBeTruthy();
    });

    it("sets an HSTS policy long enough to be preload-eligible", async () => {
      const res = await buildApp().request("http://localhost/healthz");
      const hsts = res.headers.get("Strict-Transport-Security") ?? "";

      const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1]);
      // The preload list requires >= 1 year. Anything shorter silently disqualifies the domain.
      expect(maxAge).toBeGreaterThanOrEqual(31536000);
      expect(hsts).toContain("includeSubDomains");
      expect(hsts).toContain("preload");
    });

    it("sets exactly one HSTS header", async () => {
      // Guards the ST-067 consolidation: app.ts used to append its own HSTS header alongside this
      // middleware's, and two conflicting policies are resolved by the browser, not by us.
      const res = await buildApp().request("http://localhost/healthz");

      // Duplicate headers are collapsed into one comma-joined value by the Headers API, so a second
      // policy shows up as a second max-age inside the single string.
      const hsts = res.headers.get("Strict-Transport-Security") ?? "";
      expect(hsts.match(/max-age=/g)).toHaveLength(1);
      expect(hsts).not.toContain(",");
    });

    it("still sets the matrix on an error response", async () => {
      // A 404 or a 403 is exactly when a page is most likely to be attacker-driven, so the headers
      // must not depend on a handler having run successfully.
      const res = await buildApp().request("http://localhost/nope");

      expect(res.status).toBe(404);
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  });

  describe("content security policy", () => {
    it("locks down the directives that carry the policy's weight", async () => {
      const csp = readCsp(await buildApp().request("http://localhost/healthz")) ?? "";

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });

    it("never admits unsafe-inline or unsafe-eval into script-src", async () => {
      // style-src does carry unsafe-inline (Scalar needs it); script-src must never follow, since
      // that is the directive that actually stops reflected XSS from executing.
      const csp = readCsp(await buildApp().request("http://localhost/healthz")) ?? "";
      const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";

      expect(scriptSrc).not.toContain("unsafe-inline");
      expect(scriptSrc).not.toContain("unsafe-eval");
      expect(scriptSrc).not.toContain("*");
    });

    it("stays compact enough not to weigh on every response", async () => {
      // Header bytes are paid on every single response; a CSP that has grown past ~1KB is usually
      // a sign that per-route policy is being pushed into one global string.
      const csp = readCsp(await buildApp().request("http://localhost/healthz")) ?? "";

      expect(csp.length).toBeLessThan(1024);
    });
  });

  describe("CSP exemptions", () => {
    it("omits CSP on the docs page, whose bundle is CDN-hosted", async () => {
      const app = createApp({ isReady: () => true, tracker, logger, docsEnabled: true });
      const res = await app.request("http://localhost/docs");

      expect(res.status).toBe(200);
      expect(readCsp(res)).toBeNull();
      // Only CSP is waived -- the rest of the matrix still applies to that page.
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("applies CSP to every path that is not exempt", async () => {
      const res = await buildApp().request("http://localhost/api/anything");

      expect(readCsp(res)).toBeTruthy();
    });
  });

  describe("configuration", () => {
    it("honours a caller-supplied CSP override", async () => {
      const app = new Hono();
      app.use(
        "*",
        securityHeadersMiddleware({ csp: { connectSrc: ["'self'", "https://api.example"] } }),
      );
      app.get("/", (c) => c.text("ok"));

      const csp = readCsp(await app.request("http://localhost/")) ?? "";
      expect(csp).toContain("connect-src 'self' https://api.example");
      // An override replaces one directive; the others must survive it.
      expect(csp).toContain("object-src 'none'");
    });

    it("can be switched to report-only without changing the policy", async () => {
      const app = new Hono();
      app.use("*", securityHeadersMiddleware({ reportOnly: true }));
      app.get("/", (c) => c.text("ok"));

      const res = await app.request("http://localhost/");
      expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    });
  });
});
