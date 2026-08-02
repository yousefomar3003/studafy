/**
 * Stale-JWT forced refresh (ST-133 acceptance criterion).
 *
 * A token whose `entitlements_ver` predates the subject's current version must be rejected with its
 * own error code, not silently accepted and not flattened into a generic 401 — the client has to be
 * able to tell "refresh and retry" apart from "your credential is bad".
 *
 * No database and no Redis: the reader is injected, so the version is a controlled input and the
 * lookups can be counted exactly. Counting is the only way to hold the ordering property, exactly as
 * ./short-circuit.test.ts argues for the denylist.
 */

// Imported before src/middleware — see the note at the top of ./support.ts.
import "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createFakeEntitlements, createProbeApp, get, mintToken, tamperSignature } from "./support";

import type { ProbeApp } from "./support";

let probe: ProbeApp;

beforeEach(async () => {
  probe = await createProbeApp();
});

afterEach(() => {
  probe.destroy();
});

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("a stale token is forced to refresh", () => {
  it("rejects a token whose entitlements_ver is behind the current version", async () => {
    probe.entitlements.setVersion(5);
    const token = await mintToken(probe.keyStore, { entitlements_ver: 4 });

    const response = await get(probe.app, token);

    expect(response.status).toBe(401);
    expect(probe.handlerCalls()).toBe(0);

    const problem = await body(response);
    expect(problem.code).toBe(ERROR_CODES.AUTH_ENTITLEMENTS_STALE);
    // Distinct from the revocation and malformed-token cases, which both produce AUTH_TOKEN_INVALID.
    expect(problem.code).not.toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  it("answers with the RFC 9457 problem shape and a bearer challenge", async () => {
    probe.entitlements.setVersion(9);
    const token = await mintToken(probe.keyStore, { entitlements_ver: 2 });

    const response = await get(probe.app, token);

    expect(response.headers.get("content-type")).toContain("application/problem+json");
    // 401 is the only status errorHandler attaches this to — part of why the check is a 401 rather
    // than a 409 or a non-standard 419.
    expect(response.headers.get("www-authenticate")).toBe("Bearer");

    const problem = await body(response);
    expect(problem.status).toBe(401);
    expect(problem.request_id).toBeTruthy();
  });

  it("records the failure in the structured logs with both versions", async () => {
    probe.entitlements.setVersion(7);
    await get(probe.app, await mintToken(probe.keyStore, { entitlements_ver: 3 }));

    const line = probe.lines.find((entry) => entry.reason === "entitlements_stale");
    expect(line).toBeDefined();
    expect(line?.claim).toBe(3);
    expect(line?.current).toBe(7);
  });
});

describe("a fresh token passes", () => {
  it("accepts a token at exactly the current version", async () => {
    probe.entitlements.setVersion(5);
    const response = await get(probe.app, await mintToken(probe.keyStore, { entitlements_ver: 5 }));

    expect(response.status).toBe(200);
    expect(probe.handlerCalls()).toBe(1);
  });

  // Strictly less-than, not inequality. A token minted a moment ahead of a lagging cache must not be
  // rejected — and rejecting it would make every token issued during an invalidation window fail.
  it("accepts a token ahead of the reported version", async () => {
    probe.entitlements.setVersion(4);
    const response = await get(probe.app, await mintToken(probe.keyStore, { entitlements_ver: 6 }));

    expect(response.status).toBe(200);
  });

  // The no-backfill property: every token minted before ST-133 carries a hardcoded 1, and a school
  // with no counter row resolves to exactly that.
  it("accepts a pre-ST-133 token carrying the genesis version", async () => {
    probe.entitlements.setVersion(1);
    const response = await get(probe.app, await mintToken(probe.keyStore, { entitlements_ver: 1 }));

    expect(response.status).toBe(200);
  });
});

describe("failure and disabled modes", () => {
  // Fail closed, matching the denylist. Redis is already a hard dependency of this middleware, so
  // failing open would buy no availability while accepting decisions of unknown freshness.
  it("answers 503 when the version lookup throws", async () => {
    probe.entitlements.failWith(new Error("redis down"));
    const response = await get(probe.app, await mintToken(probe.keyStore));

    expect(response.status).toBe(503);
    expect(probe.handlerCalls()).toBe(0);
  });

  it("skips the check and warns when no reader is configured", async () => {
    const noReader = await createProbeApp({ entitlements: null });
    try {
      const response = await get(
        noReader.app,
        await mintToken(noReader.keyStore, {
          entitlements_ver: 1,
        }),
      );

      expect(response.status).toBe(200);
      expect(
        noReader.lines.some((line) =>
          String(line.msg ?? "").includes("entitlement version reader unavailable"),
        ),
      ).toBe(true);
    } finally {
      noReader.destroy();
    }
  });
});

describe("ordering", () => {
  // The sibling of short-circuit.test.ts. A token that cannot pass verification must not cost an
  // entitlement lookup, and no status-code assertion can tell the two arrangements apart.
  it("never consults the reader for a token that fails verification", async () => {
    await get(probe.app, tamperSignature(await mintToken(probe.keyStore)));
    await get(probe.app, await mintToken(probe.keyStore, { ttlSeconds: -1 }));
    await get(probe.app, await mintToken(probe.keyStore, { issuer: "attacker-idp" }));
    await probe.app.request("/api/echo", { headers: { Authorization: "Basic abc" } });
    await get(probe.app);

    expect(probe.entitlements.lookups).toBe(0);
  });

  // The check runs after revocation, so a revoked token pays for one lookup rather than two.
  it("never consults the reader for a revoked token", async () => {
    const token = await mintToken(probe.keyStore);
    const jti = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).jti as string;
    await probe.denylist.revoke(jti, Math.floor(Date.now() / 1000) + 900);

    const response = await get(probe.app, token);

    expect(response.status).toBe(401);
    expect(probe.entitlements.lookups).toBe(0);
  });

  it("consults the reader exactly once for a token that reaches it", async () => {
    const fresh = createFakeEntitlements(3);
    const app = await createProbeApp({ entitlements: fresh });
    try {
      await get(app.app, await mintToken(app.keyStore, { entitlements_ver: 3 }));
      expect(fresh.lookups).toBe(1);
    } finally {
      app.destroy();
    }
  });
});
