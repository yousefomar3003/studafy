/**
 * Cache short-circuit tests (ST-070).
 *
 * The ticket requires signature validation to run *before* the Redis lookup, so a corrupted or
 * expired token costs no cache I/O. That is an ordering property, and ordering is invisible to a
 * status-code assertion — a middleware that checked Redis first and then the signature would
 * return exactly the same 401. Counting denylist lookups is the only way to hold the guarantee.
 */

// Imported before src/middleware — see the note at the top of ./support.ts.
import "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createProbeApp, get, mintToken, tamperSignature } from "./support";

import type { ProbeApp } from "./support";
import type { Role } from "@studafy/constants";

let probe: ProbeApp;

beforeEach(async () => {
  probe = await createProbeApp();
});

afterEach(() => {
  probe.destroy();
});

describe("Redis is never consulted for a token that cannot pass verification", () => {
  it("skips the lookup when no Authorization header is present", async () => {
    await get(probe.app);
    expect(probe.denylist.lookups).toBe(0);
  });

  it("skips the lookup for a malformed Authorization header", async () => {
    await probe.app.request("/api/echo", { headers: { Authorization: "Basic abc" } });
    expect(probe.denylist.lookups).toBe(0);
  });

  it("skips the lookup for a tampered signature", async () => {
    const token = await mintToken(probe.keyStore);
    await get(probe.app, tamperSignature(token));
    expect(probe.denylist.lookups).toBe(0);
  });

  it("skips the lookup for an expired token", async () => {
    const token = await mintToken(probe.keyStore, { ttlSeconds: -1 });
    await get(probe.app, token);
    expect(probe.denylist.lookups).toBe(0);
  });

  it("skips the lookup for a wrong-issuer token", async () => {
    const token = await mintToken(probe.keyStore, { issuer: "attacker-idp" });
    await get(probe.app, token);
    expect(probe.denylist.lookups).toBe(0);
  });

  it("skips the lookup for an unknown signing key", async () => {
    const other = await createProbeApp();
    const token = await mintToken(other.keyStore);
    other.destroy();

    await get(probe.app, token);
    expect(probe.denylist.lookups).toBe(0);
  });

  it("skips the lookup for structurally valid but semantically invalid claims", async () => {
    const token = await mintToken(probe.keyStore, { roles: ["ROOT"] as unknown as Role[] });
    await get(probe.app, token);
    expect(probe.denylist.lookups).toBe(0);
  });

  it("survives a burst of forged tokens without a single cache round-trip", async () => {
    // The load case the ordering exists for: a flood of garbage credentials must not turn into a
    // flood of Redis traffic.
    const token = await mintToken(probe.keyStore);
    const forged = tamperSignature(token);

    await Promise.all(Array.from({ length: 50 }, () => get(probe.app, forged)));

    expect(probe.denylist.lookups).toBe(0);
  });
});

describe("Redis is consulted exactly once for a verifiable token", () => {
  it("performs a single lookup on the happy path", async () => {
    const token = await mintToken(probe.keyStore);
    await get(probe.app, token);

    // Exactly one: a retry or a second defensive check would double the only network hop in the
    // authentication path, which is the whole latency budget.
    expect(probe.denylist.lookups).toBe(1);
  });

  it("skips the lookup on an exempt public path even with a valid token", async () => {
    await probe.app.request("/api/webhooks/erpnext", { method: "POST" });
    expect(probe.denylist.lookups).toBe(0);
  });
});
