import { randomUUID } from "node:crypto";

import { OpenAPIHono } from "@hono/zod-openapi";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockIdpOptions {
  /** Base URL the IdP is reachable at (e.g. "http://localhost:4000"). No trailing slash. */
  issuer: string;
  /** Pre-selected persona email. Used when /authorize receives no `login_hint`. */
  defaultSubject?: string;
  /** Custom claims injected into the JWT beyond the standard OIDC set. */
  defaultClaims?: Record<string, unknown>;
}

interface StoredCode {
  subject: string;
  claims: Record<string, unknown>;
  redirectUri: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 5 * 60 * 1000;
const SIGNING_ALG = "RS256";

// ---------------------------------------------------------------------------
// Mock IdP
// ---------------------------------------------------------------------------

/**
 * Create a standalone mock OIDC provider implementing the minimal surface
 * needed for local dev seeds and Playwright/Flutter E2E:
 *
 *   GET  /.well-known/openid-configuration
 *   GET  /authorize
 *   POST /token
 *   GET  /.well-known/jwks.json
 *
 * The authorize endpoint issues an authorization code immediately (no consent
 * screen) and redirects back. The token endpoint exchanges the code for a
 * signed JWT. No external state is required — the IdP is fully offline.
 *
 * Mount this Hono app at a path prefix (e.g. `app.route("/", mockIdp(...))`)
 * or run it as a standalone server via `Bun.serve`.
 */
export function createMockIdp(options: MockIdpOptions): OpenAPIHono {
  const app = new OpenAPIHono();
  const codes = new Map<string, StoredCode>();
  let keyPair: Awaited<ReturnType<typeof generateKeyPair>> | null = null;
  let kid = randomUUID();

  // Key generation happens lazily on first request so the app can be created
  // before the keys are ready. The first /token or /jwks call triggers it.

  async function ensureKeys() {
    if (keyPair) return;
    keyPair = await generateKeyPair(SIGNING_ALG, { modulusLength: 2048 });
    kid = randomUUID();
  }

  // Expired code cleanup runs on every /token call — cheap at mock-scale.

  function pruneExpiredCodes() {
    const now = Date.now();
    for (const [key, code] of codes) {
      if (now - code.createdAt > CODE_TTL_MS) codes.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // GET /.well-known/openid-configuration
  // -----------------------------------------------------------------------

  app.get("/.well-known/openid-configuration", async (c) => {
    await ensureKeys();
    return c.json({
      issuer: options.issuer,
      authorization_endpoint: `${options.issuer}/authorize`,
      token_endpoint: `${options.issuer}/token`,
      jwks_uri: `${options.issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [SIGNING_ALG],
      scopes_supported: ["openid", "profile", "email"],
    });
  });

  // -----------------------------------------------------------------------
  // GET /authorize
  //
  // Accepts standard OIDC authorize params. Immediately issues a code and
  // redirects to redirect_uri with ?code=...&state=...
  //
  // login_hint: selects the subject. Falls back to defaultSubject.
  // -----------------------------------------------------------------------

  app.get("/authorize", async (c) => {
    await ensureKeys();

    const redirectUri = c.req.query("redirect_uri");
    if (!redirectUri) {
      return c.text("redirect_uri is required", 400);
    }

    const state = c.req.query("state") ?? "";
    const subject = c.req.query("login_hint") ?? options.defaultSubject ?? "mock@test.test";
    const claims = { ...options.defaultClaims };

    const code = randomUUID();
    codes.set(code, { subject, claims, redirectUri, createdAt: Date.now() });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
  });

  // -----------------------------------------------------------------------
  // POST /token
  //
  // Exchanges an authorization code for a signed JWT. Returns the standard
  // OIDC token response shape.
  // -----------------------------------------------------------------------

  app.post("/token", async (c) => {
    await ensureKeys();
    pruneExpiredCodes();

    const body = await c.req.parseBody();
    const grantType = body.grant_type;
    const code = body.code;

    if (grantType !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }

    if (typeof code !== "string" || code.length === 0) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const stored = codes.get(code);
    if (!stored) {
      return c.json({ error: "invalid_grant" }, 400);
    }

    codes.delete(code);

    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({
      sub: stored.subject,
      ...stored.claims,
    })
      .setProtectedHeader({ alg: SIGNING_ALG, kid })
      .setIssuer(options.issuer)
      .setAudience(options.issuer)
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .setNotBefore(now)
      .setJti(randomUUID())
      .sign(keyPair!.privateKey);

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  // -----------------------------------------------------------------------
  // GET /.well-known/jwks.json
  // -----------------------------------------------------------------------

  app.get("/.well-known/jwks.json", async (c) => {
    await ensureKeys();

    const publicKey = await exportJWK(keyPair!.publicKey);
    return c.json({
      keys: [
        {
          ...publicKey,
          kid,
          alg: SIGNING_ALG,
          use: "sig",
        },
      ],
    });
  });

  return app;
}
