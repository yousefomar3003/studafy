/**
 * JWT verification middleware tests (ST-070).
 *
 * Covers the rejection matrix — missing, malformed, expired, tampered, wrong-issuer,
 * wrong-audience, unknown-key, and bad-claim tokens — plus the RFC 9457 envelope every rejection
 * is wrapped in and the context hydration a valid token produces.
 */

// Imported before src/middleware — see the note at the top of ./support.ts.
import { OpenAPIHono } from "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createLogger } from "../../src/logger";
import {
  apiProblemSchema,
  errorHandlerMiddleware,
  requestIdMiddleware,
} from "../../src/middleware";
import { jwtAuthMiddleware } from "../../src/middleware/jwtAuth";
import { KeyStore } from "../../src/modules/auth";

import {
  AUDIENCE,
  ISSUER,
  SCHOOL_ID,
  USER_ID,
  createProbeApp,
  decodePayload,
  get,
  mintToken,
  tamperSignature,
} from "./support";

import type { ProbeApp } from "./support";
import type { AppEnv } from "../../src/middleware";
import type { ErrorCode, Role } from "@studafy/constants";

let probe: ProbeApp;

beforeEach(async () => {
  probe = await createProbeApp();
});

afterEach(() => {
  probe.destroy();
});

/** Assert a response is a well-formed RFC 9457 problem document with the expected status/code. */
async function expectProblem(res: Response, status: number, code: ErrorCode): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");

  const body: unknown = await res.json();
  const parsed = apiProblemSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.code).toBe(code);
  expect(parsed.data?.status).toBe(status);

  // The trace marker in the body must be the same one the response header carries, otherwise a
  // client cannot use it to correlate with the server logs.
  expect(parsed.data?.request_id).toBe(res.headers.get("X-Request-Id") ?? undefined);
}

describe("missing or malformed credentials", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await get(probe.app);
    await expectProblem(res, 401, "AUTH_TOKEN_INVALID");
    expect(probe.handlerCalls()).toBe(0);
  });

  it("rejects a non-Bearer scheme", async () => {
    const res = await probe.app.request("/api/echo", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    await expectProblem(res, 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a Bearer header with no token", async () => {
    const res = await probe.app.request("/api/echo", { headers: { Authorization: "Bearer " } });
    await expectProblem(res, 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a token that is not a JWT", async () => {
    const res = await get(probe.app, "not-a-jwt");
    await expectProblem(res, 401, "AUTH_TOKEN_INVALID");
  });

  it("accepts a lowercase bearer scheme", async () => {
    // RFC 7235 defines auth-scheme as case-insensitive, and real clients do send "bearer".
    const token = await mintToken(probe.keyStore);
    const res = await probe.app.request("/api/echo", {
      headers: { Authorization: `bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("answers 401 with a WWW-Authenticate challenge", async () => {
    const res = await get(probe.app);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });
});

describe("expired tokens", () => {
  it("rejects a token minted by the genuine signing service with a past exp", async () => {
    const token = await mintToken(probe.keyStore, { ttlSeconds: -1 });
    const res = await get(probe.app, token);

    // Distinguished from a generic invalid token so a client knows to refresh rather than re-login.
    await expectProblem(res, 401, "AUTH_TOKEN_EXPIRED");
    expect(probe.handlerCalls()).toBe(0);
  });

  it("records the expiry in the structured logs", async () => {
    const token = await mintToken(probe.keyStore, { ttlSeconds: -1 });
    await get(probe.app, token);

    const warning = probe.lines.find((line) => line.msg === "authentication failed");
    expect(warning).toBeDefined();
    expect(warning?.reason).toBe("expired");
  });
});

describe("signature tampering", () => {
  it("rejects a token with one character changed in the signature", async () => {
    const token = await mintToken(probe.keyStore);
    const res = await get(probe.app, tamperSignature(token));

    await expectProblem(res, 401, "AUTH_TOKEN_INVALID");
  });

  it("isolates the route context — the handler never runs", async () => {
    const token = await mintToken(probe.keyStore);
    await get(probe.app, tamperSignature(token));

    expect(probe.handlerCalls()).toBe(0);
  });

  it("records an authentication warning in the structured logs (ST-054)", async () => {
    const token = await mintToken(probe.keyStore);
    await get(probe.app, tamperSignature(token));

    const warning = probe.lines.find((line) => line.msg === "authentication failed");
    expect(warning).toBeDefined();
    expect(warning?.reason).toBe("signature");
    // Level 40 is warn in the pino wire format this logger emits.
    expect(warning?.level).toBe(40);
    expect(warning?.request_id).toBeString();
  });

  it("never writes the token itself into the logs", async () => {
    const token = await mintToken(probe.keyStore);
    await get(probe.app, tamperSignature(token));

    // A rejected token is still a live credential until it expires, and log sinks reach a wider
    // audience than the request path. Check the whole serialized batch, not just known fields.
    const serialized = JSON.stringify(probe.lines);
    expect(serialized).not.toContain(token.split(".")[2]);
  });

  it("rejects a payload edited to escalate the tenant", async () => {
    // The realistic attack: rewrite school_id to another tenant and hope the signature is not
    // checked. Signature verification runs over the payload, so this cannot survive.
    const token = await mintToken(probe.keyStore);
    const [header, , signature] = token.split(".");

    const claims = decodePayload(token);
    claims.school_id = "33333333-3333-3333-3333-333333333333";
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");

    const res = await get(probe.app, `${header}.${forgedPayload}.${signature}`);
    await expectProblem(res, 401, "AUTH_TOKEN_INVALID");
  });
});

describe("claim validation", () => {
  it("rejects a token with the wrong issuer", async () => {
    const token = await mintToken(probe.keyStore, { issuer: "attacker-idp" });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await mintToken(probe.keyStore, { audience: "some-other-api" });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a token whose kid is not in the key set", async () => {
    // Signed correctly, but by a different authority — the classic key-confusion attempt.
    const other = await createProbeApp();
    const token = await mintToken(other.keyStore);
    other.destroy();

    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a role outside the app.user_role enum", async () => {
    // Loosely typed role arrays are what this guards against: an unrecognised role must fail the
    // whole token rather than silently degrading to a smaller permission set.
    const token = await mintToken(probe.keyStore, { roles: ["ROOT_ADMIN"] as unknown as Role[] });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects an empty roles array", async () => {
    const token = await mintToken(probe.keyStore, { roles: [] });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a non-UUID sub", async () => {
    const token = await mintToken(probe.keyStore, { sub: "admin" });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects a non-UUID school_id", async () => {
    // school_id feeds the app.school_id GUC that every RLS policy reads. A malformed value must
    // never reach a transaction.
    const token = await mintToken(probe.keyStore, { school_id: "'; DROP TABLE app.users; --" });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });

  it("rejects an unrecognised channel", async () => {
    const token = await mintToken(probe.keyStore, { channel: "cli" });
    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });
});

describe("valid tokens", () => {
  it("passes the request through to the handler", async () => {
    const token = await mintToken(probe.keyStore);
    const res = await get(probe.app, token);

    expect(res.status).toBe(200);
    expect(probe.handlerCalls()).toBe(1);
  });

  it("hydrates the full auth context", async () => {
    const token = await mintToken(probe.keyStore, {
      roles: ["ORG_ADMIN", "INSTRUCTOR"] as Role[],
      channel: "mobile",
      entitlements_ver: 7,
    });
    await get(probe.app, token);

    expect(probe.lastAuth()).toMatchObject({
      userId: USER_ID,
      schoolId: SCHOOL_ID,
      roles: ["ORG_ADMIN", "INSTRUCTOR"],
      channel: "mobile",
      entitlementsVer: 7,
    });
  });

  it("re-childs the request logger with the established identity", async () => {
    const token = await mintToken(probe.keyStore);
    await get(probe.app, token);

    // requestIdMiddleware binds school_id/user_id as null on the way in because no identity exists
    // yet; the auth middleware rebinds them. The completion line is emitted on the unwind, so it
    // must carry the real values — this is the seam SAD_28 describes.
    const completed = probe.lines.find((line) => line.msg === "request completed");
    expect(completed?.school_id).toBe(SCHOOL_ID);
    expect(completed?.user_id).toBe(USER_ID);
  });

  it("still accepts a token signed with the previous key after a rotation", async () => {
    // The two-key JWKS overlap window: tokens minted just before a rotation must stay usable until
    // they expire, or every rotation would log the whole userbase out.
    const token = await mintToken(probe.keyStore);
    await probe.keyStore.rotate();

    const res = await get(probe.app, token);
    expect(res.status).toBe(200);
  });

  it("rejects a token whose key has rotated fully out of the window", async () => {
    const token = await mintToken(probe.keyStore);
    await probe.keyStore.rotate();
    await probe.keyStore.rotate();

    await expectProblem(await get(probe.app, token), 401, "AUTH_TOKEN_INVALID");
  });
});

describe("public paths", () => {
  it("lets the webhook prefix through without a token", async () => {
    // ERPNext authenticates by HMAC signature, not a session token — see src/erpnext/webhook.ts.
    const res = await probe.app.request("/api/webhooks/erpnext", { method: "POST" });
    expect(res.status).toBe(200);
    expect(probe.handlerCalls()).toBe(1);
  });
});

describe("degraded key store", () => {
  it("answers 503 rather than 401 when no keys are available", async () => {
    // An empty key store is a server fault, not a bad credential. Answering 401 would send every
    // client into a refresh loop against a server that cannot verify anything.
    const token = await mintToken(probe.keyStore);

    // Never initialized, so it holds no keys at all.
    const logger = createLogger({ destination: () => undefined });
    const app = new OpenAPIHono<AppEnv>();
    app.use("*", requestIdMiddleware({ logger }));
    app.use(
      "/api/*",
      jwtAuthMiddleware({
        keyStore: new KeyStore(60_000),
        denylist: null,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    );
    app.get("/api/echo", (c) => c.json({ handled: true }));
    app.onError(errorHandlerMiddleware(logger));

    const res = await app.request("/api/echo", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(503);
  });
});
