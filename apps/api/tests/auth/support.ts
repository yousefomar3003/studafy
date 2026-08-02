// OpenAPIHono rather than plain Hono, and imported first: src/openapi/components.ts decorates
// schemas from @studafy/shared-schemas with `.openapi()`, which only exists once
// @hono/zod-openapi has been loaded. Reaching src/middleware or src/modules/auth before that
// throws at module-init. Every other suite gets this for free by importing src/app, whose first
// line is the same package; this one does not build the real app, so it says so explicitly.
import { OpenAPIHono } from "@hono/zod-openapi";

import { createLogger } from "../../src/logger";
import { errorHandlerMiddleware, requestIdMiddleware } from "../../src/middleware";
import { jwtAuthMiddleware } from "../../src/middleware/jwtAuth";
import { AUTH_CHANNELS, KeyStore, signAccessToken } from "../../src/modules/auth";

import type { LogFields, Logger } from "../../src/logger";
import type { AppEnv } from "../../src/middleware";
import type { EntitlementVersionReader } from "../../src/middleware/jwtAuth";
import type { DenylistEntry, JtiDenylist } from "../../src/modules/auth";
import type { Role } from "@studafy/constants";

/**
 * Shared fixtures for the authentication suites.
 *
 * The service still has no protected business routes, so asserting against the real app would mean
 * a request that *passes* authentication lands on the 404 handler — and "not 401" is weak evidence
 * that a handler actually ran. These probe apps carry a real echo route so pass-through is
 * directly observable, following the pattern established in tests/security/csrf.test.ts.
 */

export const ISSUER = "studafy-test";
export const AUDIENCE = "studafy-api-test";

export const USER_ID = "11111111-1111-1111-1111-111111111111";
export const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// Capturing logger
// ---------------------------------------------------------------------------

export interface CapturedLine extends LogFields {
  msg?: string;
}

/**
 * A logger that keeps every emitted line in an array.
 *
 * ST-054 requires authentication failures to be recorded in the structured logs, and the only way
 * to prove that is to read what was written — a silent logger would make the assertion vacuous.
 */
export function createCapturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const logger = createLogger({
    destination: (line: string) => {
      lines.push(JSON.parse(line) as CapturedLine);
    },
  });
  return { logger, lines };
}

// ---------------------------------------------------------------------------
// In-memory denylist
// ---------------------------------------------------------------------------

export interface FakeDenylist extends JtiDenylist {
  /** How many times isRevoked was consulted. The short-circuit tests assert on this. */
  readonly lookups: number;
  /** Make the next and all subsequent lookups throw, simulating a Redis outage. */
  failWith(err: Error): void;
}

/**
 * An in-process JtiDenylist. Used instead of a real Redis client so the suites run in CI without
 * a Redis instance, and so `lookups` can be counted exactly.
 */
export function createFakeDenylist(): FakeDenylist {
  const revoked = new Set<string>();
  let lookups = 0;
  let failure: Error | null = null;

  return {
    get lookups() {
      return lookups;
    },
    failWith(err: Error) {
      failure = err;
    },
    isRevoked(jti: string) {
      lookups += 1;
      if (failure) return Promise.reject(failure);
      return Promise.resolve(revoked.has(jti));
    },
    revoke(jti: string) {
      revoked.add(jti);
      return Promise.resolve();
    },
    revokeMany(entries: readonly DenylistEntry[]) {
      // Mirrors the real implementation's contract: already-expired entries are skipped rather than
      // written, and the count returned is what actually landed. Tests asserting on denylisted counts
      // depend on that, so the fake cannot simply add everything.
      const nowSeconds = Math.floor(Date.now() / 1000);
      let written = 0;
      for (const entry of entries) {
        if (entry.expUnixSeconds - nowSeconds <= 0) continue;
        revoked.add(entry.jti);
        written += 1;
      }
      if (failure) return Promise.reject(failure);
      return Promise.resolve(written);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory entitlement version reader
// ---------------------------------------------------------------------------

export interface FakeEntitlements extends EntitlementVersionReader {
  /** How many times currentVersion was consulted. The ordering tests assert on this. */
  readonly lookups: number;
  /** Set the version every subsequent lookup reports. */
  setVersion(version: number): void;
  /** Make the next and all subsequent lookups throw, simulating a Redis outage. */
  failWith(err: Error): void;
}

/**
 * An in-process EntitlementVersionReader.
 *
 * In-memory rather than a real service for the same reasons as createFakeDenylist: the suites run in
 * CI without Redis or a database, and `lookups` can be counted exactly — which is the only way to
 * prove the check runs *after* signature verification rather than before it.
 */
export function createFakeEntitlements(initialVersion = 1): FakeEntitlements {
  let version = initialVersion;
  let lookups = 0;
  let failure: Error | null = null;

  return {
    get lookups() {
      return lookups;
    },
    setVersion(next: number) {
      version = next;
    },
    failWith(err: Error) {
      failure = err;
    },
    currentVersion() {
      lookups += 1;
      if (failure) return Promise.reject(failure);
      return Promise.resolve(version);
    },
  };
}

// ---------------------------------------------------------------------------
// Probe app
// ---------------------------------------------------------------------------

export interface ProbeApp {
  app: OpenAPIHono<AppEnv>;
  keyStore: KeyStore;
  denylist: FakeDenylist;
  entitlements: FakeEntitlements;
  lines: CapturedLine[];
  /** What the echo route saw in `c.get("auth")` on the most recent request that reached it. */
  lastAuth: () => unknown;
  /** How many times the echo route ran. Zero proves the middleware short-circuited. */
  handlerCalls: () => number;
  destroy: () => void;
}

/**
 * Build the minimal real stack — request id, JWT auth, an echo route, and the production error
 * handler — around a freshly initialized KeyStore.
 */
export async function createProbeApp(
  options: { denylist?: FakeDenylist | null; entitlements?: FakeEntitlements | null } = {},
): Promise<ProbeApp> {
  const { logger, lines } = createCapturingLogger();
  const keyStore = new KeyStore(60_000);
  await keyStore.init();

  const denylist = options.denylist === undefined ? createFakeDenylist() : options.denylist;
  // Defaults to a reader reporting the genesis version 1, which is what mintToken puts in the claim.
  // Every pre-existing suite therefore keeps passing the new check without knowing it exists.
  const entitlements =
    options.entitlements === undefined ? createFakeEntitlements() : options.entitlements;

  let observedAuth: unknown = undefined;
  let calls = 0;

  const app = new OpenAPIHono<AppEnv>();
  app.use("*", requestIdMiddleware({ logger }));
  app.use(
    "/api/*",
    jwtAuthMiddleware({ keyStore, denylist, entitlements, issuer: ISSUER, audience: AUDIENCE }),
  );
  app.get("/api/echo", (c) => {
    calls += 1;
    observedAuth = c.get("auth");
    return c.json({ handled: true, auth: c.get("auth") });
  });
  app.post("/api/webhooks/erpnext", (c) => {
    calls += 1;
    return c.json({ handled: true });
  });
  app.get("/api/auth/invitations/:token/verify", (c) => {
    calls += 1;
    return c.json({ handled: true });
  });
  app.get("/api/auth/invitations/:token/manage", (c) => {
    calls += 1;
    return c.json({ handled: true });
  });
  app.onError(errorHandlerMiddleware(logger));

  return {
    app,
    keyStore,
    // Callers that pass `denylist: null` get a stub back so the shape stays uniform; they are
    // asserting on the null-denylist branch and never read it.
    denylist: denylist ?? createFakeDenylist(),
    entitlements: entitlements ?? createFakeEntitlements(),
    lines,
    lastAuth: () => observedAuth,
    handlerCalls: () => calls,
    destroy: () => keyStore.destroy(),
  };
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export interface TokenOverrides {
  sub?: string;
  school_id?: string;
  roles?: Role[];
  entitlements_ver?: number;
  channel?: string;
  subscription_status?: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
}

/** Mint a token through the genuine signing service. */
export function mintToken(keyStore: KeyStore, overrides: TokenOverrides = {}): Promise<string> {
  return signAccessToken(
    keyStore,
    {
      sub: overrides.sub ?? USER_ID,
      school_id: overrides.school_id ?? SCHOOL_ID,
      roles: overrides.roles ?? (["INSTRUCTOR"] as Role[]),
      entitlements_ver: overrides.entitlements_ver ?? 1,
      channel: (overrides.channel ?? AUTH_CHANNELS.WEB) as never,
      subscription_status: (overrides.subscription_status ?? "active") as never,
    },
    {
      issuer: overrides.issuer ?? ISSUER,
      audience: overrides.audience ?? AUDIENCE,
      ttlSeconds: overrides.ttlSeconds ?? 900,
    },
  );
}

/**
 * Flip one character inside the signature segment, leaving header and payload untouched.
 *
 * This is the realistic tampering case: an attacker who edits the payload must also produce a
 * matching signature, and the closest they can get is a signature that is one character off.
 */
export function tamperSignature(token: string): string {
  const [header, payload, signature] = token.split(".");
  const index = Math.floor(signature.length / 2);
  const original = signature[index];
  const replacement = original === "A" ? "B" : "A";
  return `${header}.${payload}.${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
}

/** Decode a token's payload without verifying it — assertion-only. */
export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<
    string,
    unknown
  >;
}

/** GET /api/echo with a bearer token. */
export function get(
  app: OpenAPIHono<AppEnv>,
  token?: string,
  path = "/api/echo",
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "GET",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}
