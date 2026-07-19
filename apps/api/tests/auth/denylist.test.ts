/**
 * Redis jti denylist tests (ST-070).
 *
 * Two layers: the client module's key/TTL contract against a stubbed Redis, and the middleware
 * boundary that consults it — proving a revoked token is stopped before any route runs.
 */

// Imported before src/middleware — see the note at the top of ./support.ts.
import "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { apiProblemSchema } from "../../src/middleware";
import { JTI_DENYLIST_PREFIX, createJtiDenylist, jtiDenylistKey } from "../../src/modules/auth";

import { createFakeDenylist, createProbeApp, decodePayload, get, mintToken } from "./support";

import type { ProbeApp } from "./support";
import type { RedisClient } from "../../src/redis";

// ---------------------------------------------------------------------------
// Redis stub
// ---------------------------------------------------------------------------

interface StubRedis {
  client: RedisClient;
  /** Every SET issued, in order, with the TTL it carried. */
  writes: { key: string; value: string; mode: string; ttl: number }[];
  /** Keys that EXISTS should report as present. */
  present: Set<string>;
}

function createStubRedis(): StubRedis {
  const writes: StubRedis["writes"] = [];
  const present = new Set<string>();

  const client = {
    exists: (key: string) => Promise.resolve(present.has(key) ? 1 : 0),
    set: (key: string, value: string, mode: string, ttl: number) => {
      writes.push({ key, value, mode, ttl });
      present.add(key);
      return Promise.resolve("OK");
    },
  } as unknown as RedisClient;

  return { client, writes, present };
}

// ---------------------------------------------------------------------------
// Client module
// ---------------------------------------------------------------------------

describe("createJtiDenylist", () => {
  const JTI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const NOW_MS = 1_700_000_000_000;
  const NOW_S = Math.floor(NOW_MS / 1000);

  it("writes a flat key under the documented prefix", async () => {
    const redis = createStubRedis();
    const denylist = createJtiDenylist(redis.client, { now: () => NOW_MS });

    await denylist.revoke(JTI, NOW_S + 300);

    // A single flat string key is what makes the lookup O(1); anything set- or hash-shaped would
    // scale with the number of revoked tokens.
    expect(redis.writes).toHaveLength(1);
    expect(redis.writes[0].key).toBe(`${JTI_DENYLIST_PREFIX}${JTI}`);
    expect(jtiDenylistKey(JTI)).toBe(redis.writes[0].key);
  });

  it("sets the TTL to the token's remaining lifetime", async () => {
    const redis = createStubRedis();
    const denylist = createJtiDenylist(redis.client, { now: () => NOW_MS });

    await denylist.revoke(JTI, NOW_S + 742);

    // exp - now, so the entry self-prunes the moment the token would have expired anyway. A fixed
    // TTL would either leak memory or drop the entry while the token is still usable.
    expect(redis.writes[0].mode).toBe("EX");
    expect(redis.writes[0].ttl).toBe(742);
  });

  it("writes nothing for an already-expired token", async () => {
    const redis = createStubRedis();
    const denylist = createJtiDenylist(redis.client, { now: () => NOW_MS });

    await denylist.revoke(JTI, NOW_S - 1);

    // Verification rejects it on exp before the denylist is ever consulted, so an entry would be
    // dead weight — and a non-positive TTL is an error in Redis.
    expect(redis.writes).toHaveLength(0);
  });

  it("reports a revoked jti as revoked and an unknown one as not", async () => {
    const redis = createStubRedis();
    const denylist = createJtiDenylist(redis.client, { now: () => NOW_MS });

    await denylist.revoke(JTI, NOW_S + 300);

    expect(await denylist.isRevoked(JTI)).toBe(true);
    expect(await denylist.isRevoked("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Middleware boundary
// ---------------------------------------------------------------------------

describe("revocation at the middleware boundary", () => {
  let probe: ProbeApp;

  beforeEach(async () => {
    probe = await createProbeApp();
  });

  afterEach(() => {
    probe.destroy();
  });

  it("rejects a token whose jti has been revoked", async () => {
    const token = await mintToken(probe.keyStore);
    const { jti } = decodePayload(token) as { jti: string };

    // The token is accepted before revocation — so the rejection below is attributable to the
    // denylist and nothing else.
    expect((await get(probe.app, token)).status).toBe(200);

    await probe.denylist.revoke(jti, Math.floor(Date.now() / 1000) + 900);

    const res = await get(probe.app, token);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(apiProblemSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("ignores downstream routers entirely for a revoked token", async () => {
    const token = await mintToken(probe.keyStore);
    const { jti } = decodePayload(token) as { jti: string };
    await probe.denylist.revoke(jti, Math.floor(Date.now() / 1000) + 900);

    const before = probe.handlerCalls();
    await get(probe.app, token);

    expect(probe.handlerCalls()).toBe(before);
  });

  it("records the revocation in the structured logs", async () => {
    const token = await mintToken(probe.keyStore);
    const { jti } = decodePayload(token) as { jti: string };
    await probe.denylist.revoke(jti, Math.floor(Date.now() / 1000) + 900);
    await get(probe.app, token);

    const warning = probe.lines.find((line) => line.msg === "authentication failed");
    expect(warning?.reason).toBe("revoked");
  });

  it("fails closed with a 503 when the denylist is unreachable", async () => {
    // The opposite of the rate limiter, which fails open. Passing traffic through here would
    // silently resurrect every logged-out session for the duration of a Redis outage, so an
    // outage has to surface as visible downtime instead.
    const token = await mintToken(probe.keyStore);
    probe.denylist.failWith(new Error("ECONNREFUSED"));

    const res = await get(probe.app, token);
    expect(res.status).toBe(503);
    expect(probe.handlerCalls()).toBe(0);
  });

  it("does not enforce revocation when no denylist is configured", async () => {
    // Local development without Redis. Documented as a warning on every request rather than a
    // silent behaviour change.
    const unguarded = await createProbeApp({ denylist: null });
    const token = await mintToken(unguarded.keyStore);

    const res = await get(unguarded.app, token);
    expect(res.status).toBe(200);
    expect(
      unguarded.lines.some(
        (line) => line.msg === "jti denylist unavailable — token revocation is not enforced",
      ),
    ).toBe(true);

    unguarded.destroy();
  });
});

// ---------------------------------------------------------------------------
// Fake-denylist self-check
// ---------------------------------------------------------------------------

describe("fake denylist", () => {
  it("matches the JtiDenylist contract the middleware depends on", async () => {
    // The suites above lean on this stub, so its behaviour is worth pinning: if it drifted from
    // the real client, every assertion built on it would quietly become meaningless.
    const fake = createFakeDenylist();
    expect(await fake.isRevoked("x")).toBe(false);
    await fake.revoke("x", 0);
    expect(await fake.isRevoked("x")).toBe(true);
    expect(fake.lookups).toBe(2);
  });
});
