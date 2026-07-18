/**
 * CORS middleware integration tests (ST-067).
 *
 * Covers preflight handling, the strict origin allowlist, and the rule that matters most for a
 * credentialed API: an origin that is not on the list never receives access-control headers, so a
 * browser refuses to hand the response to the calling page.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";

const logger = createLogger({ destination: () => undefined });
const tracker = createInflightTracker();

/** On the default localhost allowlist that development/test falls back to. */
const ALLOWED_ORIGIN = "http://localhost:5173";
const FOREIGN_ORIGIN = "https://malicious-site.com";

function buildApp() {
  return createApp({ isReady: () => true, tracker, logger });
}

describe("CORS middleware", () => {
  beforeEach(resetSecurityConfig);
  afterEach(resetSecurityConfig);

  describe("preflight", () => {
    it("answers a preflight from an allowlisted origin with credentials enabled", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        method: "OPTIONS",
        headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
      // Without Vary, a shared cache could serve one origin's permissive response to another.
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("advertises the headers the app's own middleware chain requires", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        method: "OPTIONS",
        headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
      });

      const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
      // A browser drops any of these that is not advertised, which would break CSRF (X-XSRF-TOKEN)
      // or idempotent retries (Idempotency-Key) in a way that looks like a server bug.
      for (const header of [
        "Authorization",
        "Content-Type",
        "X-XSRF-TOKEN",
        "Idempotency-Key",
        "Accept-Language",
      ]) {
        expect(allowed).toContain(header);
      }
    });

    it("rejects a preflight probe from an undocumented origin", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        method: "OPTIONS",
        headers: { Origin: FOREIGN_ORIGIN, "Access-Control-Request-Method": "GET" },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });

    it("rejects a preflight carrying no Origin at all", async () => {
      const res = await buildApp().request("http://localhost/healthz", { method: "OPTIONS" });

      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("never answers with a wildcard, which is invalid alongside credentials", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        method: "OPTIONS",
        headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "GET" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    });
  });

  describe("origin allowlist", () => {
    it("grants access-control headers to an allowlisted origin on a normal request", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        headers: { Origin: ALLOWED_ORIGIN },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });

    it("withholds access-control headers from a foreign origin", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        headers: { Origin: FOREIGN_ORIGIN },
      });

      // The request still executes -- CORS is a browser-enforced read restriction, not server-side
      // authorization -- but with no ACAO header the browser refuses to expose the body.
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });

    it("rejects an origin that merely embeds an allowlisted one", async () => {
      // The classic allowlist bypasses: a suffix-matched attacker subdomain, a prefixed hostname,
      // and a scheme swap. All three pass a naive `includes()` check.
      for (const origin of [
        "http://localhost:5173.attacker.com",
        "http://evil-localhost:5173",
        "https://localhost:5173",
      ]) {
        const res = await buildApp().request("http://localhost/healthz", {
          headers: { Origin: origin },
        });
        expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
    });

    it("matches an allowlisted origin case-insensitively", async () => {
      const res = await buildApp().request("http://localhost/healthz", {
        headers: { Origin: "HTTP://LOCALHOST:5173" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    });

    it("serves a same-origin request that carries no Origin header", async () => {
      const res = await buildApp().request("http://localhost/healthz");

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Vary")).toBe("Origin");
    });
  });
});
