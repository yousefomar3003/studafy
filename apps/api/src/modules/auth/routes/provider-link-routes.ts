/**
 * OAuth provider linking routes — lockout resilience (R-03).
 *
 * Self-service and administrative endpoints for linking and unlinking OAuth providers.
 *
 *   GET    /api/auth/providers                           — list linked providers
 *   POST   /api/auth/providers/link/start                 — initiate linking OAuth flow
 *   DELETE /api/auth/providers/{provider}                 — unlink own provider
 *   DELETE /api/admin/users/{userId}/providers/{provider} — admin unlink
 *   GET    /api/auth/oauth/{provider}/link/callback       — OAuth callback for linking
 *
 * The callback is public (under /api/auth/oauth which is in DEFAULT_PUBLIC_PATHS) because it is
 * reached after a browser redirect from the OAuth provider — no bearer token is available. The
 * state parameter carries the user binding and purpose.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { getGoogleOAuthConfig, GOOGLE_AUTH_ENDPOINT, GOOGLE_SCOPES } from "../oauth/config";
import { validateGoogleIdToken } from "../oauth/google-id-token";
import {
  getMicrosoftOAuthConfig,
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
} from "../oauth/microsoft-config";
import { validateMicrosoftIdToken } from "../oauth/microsoft-id-token";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oauth/pkce";
import { createStateStore } from "../oauth/state-store";
import {
  completeProviderLink,
  listLinkedProviders,
  unlinkProvider,
} from "../services/provider-link-service";

import {
  adminProviderPathParams,
  linkStartBodySchema,
  linkStartResponseSchema,
  listProvidersResponseSchema,
  providerPathParams,
  unlinkResponseSchema,
} from "./provider-link-schemas";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listProvidersRoute = createRoute({
  method: "get",
  path: "/api/auth/providers",
  tags: ["Auth"],
  operationId: "listLinkedProviders",
  summary: "List linked OAuth providers",
  description:
    "Returns the OAuth providers linked to the authenticated user's account. Each entry " +
    "includes the provider name and the time it was linked.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "The caller's linked providers.",
        schema: listProvidersResponseSchema,
      },
    },
    [401, 429, 500],
  ),
});

const linkStartAudit = auditAction("insert", "oauth_identities");

const linkStartRoute = createRoute({
  method: "post",
  path: "/api/auth/providers/link/start",
  tags: ["Auth"],
  operationId: "startProviderLink",
  summary: "Start linking an OAuth provider",
  description:
    "Initiates an OAuth authorization flow to link a second provider to the authenticated " +
    "user's account. Returns a redirect URL the client should navigate to. On successful " +
    "callback, the provider's identity is linked to this account for lockout resilience.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: linkStartBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "OAuth redirect URL for the client to navigate to.",
        schema: linkStartResponseSchema,
      },
    },
    [400, 401, 409, 429, 500],
  ),
});

const unlinkAudit = auditAction("delete", "oauth_identities");

const unlinkRoute = createRoute({
  method: "delete",
  path: "/api/auth/providers/{provider}",
  tags: ["Auth"],
  operationId: "unlinkProvider",
  summary: "Unlink an OAuth provider",
  description:
    "Removes an OAuth provider from the authenticated user's account. Refuses if this is the " +
    "last linked provider, which would leave the account without any login method.",
  security: [{ bearerAuth: [] }],
  request: { params: providerPathParams },
  responses: standardResponses(
    {
      200: {
        description: "The provider was unlinked.",
        schema: unlinkResponseSchema,
      },
    },
    [400, 401, 404, 409, 429, 500],
  ),
});

const adminUnlinkAudit = auditAction("delete", "oauth_identities");

const adminUnlinkRoute = createRoute({
  method: "delete",
  path: "/api/admin/users/{userId}/providers/{provider}",
  tags: ["Admin"],
  operationId: "adminUnlinkProvider",
  summary: "Admin: unlink a user's OAuth provider",
  description:
    "Removes an OAuth provider from a user's account on an administrator's behalf. Refuses " +
    "if this is the user's last linked provider. Requires USER_SUSPEND permission.",
  security: [{ bearerAuth: [] }],
  request: { params: adminProviderPathParams },
  responses: standardResponses(
    {
      200: {
        description: "The provider was unlinked.",
        schema: unlinkResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the provider-link route group.
 *
 * Requires a database, a session-token config (unused directly but keeps factory shape consistent),
 * and a logger.
 */
export function providerLinkRoutes(
  db: Database,
  _config: unknown,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Shared state store for the link OAuth flow. In-memory is fine for single-instance (KISS).
  const stateStore = createStateStore();

  // --- List providers -------------------------------------------------------

  routes.openapi(listProvidersRoute, async (c) => {
    const auth = requireAuth(c);

    const result = await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => listLinkedProviders(tx, auth.userId),
    );

    return c.json(
      {
        providers: result.providers.map((p) => ({
          provider: p.provider,
          linked_at: p.linkedAt.toISOString(),
        })),
      },
      200,
    );
  });

  // --- Link start -----------------------------------------------------------
  routes.use("/api/auth/providers/link/start", linkStartAudit);

  routes.openapi(linkStartRoute, async (c) => {
    const auth = requireAuth(c);
    const { provider } = c.req.valid("json");

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    stateStore.set(state, {
      codeVerifier,
      nonce,
      createdAt: Date.now(),
      purpose: "link",
      userId: auth.userId,
      schoolId: auth.schoolId,
    });

    let redirectUrl: string;

    if (provider === "google") {
      const oauthConfig = getGoogleOAuthConfig();
      if (!oauthConfig) {
        throw new HTTPException(404, { message: "Google OAuth is not configured" });
      }

      const params = new URLSearchParams({
        client_id: oauthConfig.clientId,
        redirect_uri: oauthConfig.redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        access_type: "offline",
      });

      redirectUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
    } else {
      const oauthConfig = getMicrosoftOAuthConfig();
      if (!oauthConfig) {
        throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
      }

      const params = new URLSearchParams({
        client_id: oauthConfig.clientId,
        redirect_uri: oauthConfig.redirectUri,
        response_type: "code",
        scope: MICROSOFT_SCOPES,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        response_mode: "query",
      });

      redirectUrl = `${MICROSOFT_AUTH_ENDPOINT}?${params.toString()}`;
    }

    return c.json({ redirect_url: redirectUrl }, 200);
  });

  // --- Unlink (self-service) ------------------------------------------------
  routes.use("/api/auth/providers/:provider", unlinkAudit);

  routes.openapi(unlinkRoute, async (c) => {
    const auth = requireAuth(c);
    const { provider } = c.req.valid("param");

    await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) =>
        unlinkProvider(tx, {
          userId: auth.userId,
          schoolId: auth.schoolId,
          provider,
          requestId: c.get("requestId"),
          logger: c.get("log"),
        }),
    );

    return c.json({ provider }, 200);
  });

  // --- Admin unlink ---------------------------------------------------------
  const adminGuard = requirePermission(PERMISSIONS.USER_SUSPEND);
  routes.use("/api/admin/users/:userId/providers/:provider", adminGuard);
  routes.use("/api/admin/users/:userId/providers/:provider", adminUnlinkAudit);

  routes.openapi(adminUnlinkRoute, async (c) => {
    const auth = requireAuth(c);
    const { userId: targetUserId, provider } = c.req.valid("param");

    await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) =>
        unlinkProvider(tx, {
          userId: targetUserId,
          schoolId: auth.schoolId,
          provider,
          requestId: c.get("requestId"),
          logger: c.get("log"),
        }),
    );

    c.get("log").info(
      { target_user_id: targetUserId, provider },
      "administrator unlinked provider",
    );

    return c.json({ provider }, 200);
  });

  // --- Link callback (public, browser redirect) -----------------------------
  // This is a plain Hono route like the existing Google/Microsoft OAuth callbacks, not an
  // OpenAPI route: the response is a redirect, not a JSON body.
  setupLinkCallback(routes, db, stateStore, logger);

  return routes;
}

// ---------------------------------------------------------------------------
// Link callback
// ---------------------------------------------------------------------------

function setupLinkCallback(
  routes: OpenAPIHono<AppEnv>,
  db: Database,
  stateStore: ReturnType<typeof createStateStore>,
  logger: Logger,
): void {
  // Google link callback
  routes.get("/api/auth/oauth/google/link/callback", async (c) => {
    await handleLinkCallback(c, db, stateStore, logger, "google");
  });

  // Microsoft link callback
  routes.get("/api/auth/oauth/microsoft/link/callback", async (c) => {
    await handleLinkCallback(c, db, stateStore, logger, "microsoft");
  });
}

async function handleLinkCallback(
  c: Context<AppEnv>,
  db: Database,
  stateStore: ReturnType<typeof createStateStore>,
  logger: Logger,
  provider: "google" | "microsoft",
): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const frontendUrl =
    provider === "google"
      ? (getGoogleOAuthConfig()?.frontendUrl ?? "/")
      : (getMicrosoftOAuthConfig()?.frontendUrl ?? "/");

  if (!code || !state) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.OAUTH_STATE_INVALID,
      "Missing code or state parameter",
    );
  }

  // 1. Validate state
  const entry = stateStore.get(state);
  if (!entry || entry.purpose !== "link" || !entry.userId || !entry.schoolId) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.OAUTH_STATE_INVALID,
      "Invalid or expired link state",
    );
  }
  stateStore.delete(state);

  const { userId, schoolId, codeVerifier, nonce } = entry;

  // 2. Exchange authorization code for tokens
  let idToken: string;
  if (provider === "google") {
    const oauthConfig = getGoogleOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Google OAuth is not configured" });
    }
    idToken = await exchangeCode(
      "https://oauth2.googleapis.com/token",
      oauthConfig.clientId,
      oauthConfig.clientSecret,
      oauthConfig.redirectUri,
      code,
      codeVerifier,
    );

    // 3. Validate id_token
    const claims = await validateGoogleIdToken(idToken, oauthConfig.clientId, nonce);

    // 4. Link identity
    await withTenantTx(db, { schoolId, userId }, (tx) =>
      completeProviderLink(tx, {
        userId,
        schoolId,
        provider: "google",
        subject: claims.sub,
        email: claims.email,
        logger,
      }),
    );
  } else {
    const oauthConfig = getMicrosoftOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }
    idToken = await exchangeCode(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      oauthConfig.clientId,
      oauthConfig.clientSecret,
      oauthConfig.redirectUri,
      code,
      codeVerifier,
    );

    // 3. Validate id_token
    const claims = await validateMicrosoftIdToken(idToken, oauthConfig.clientId, nonce);

    // 4. Link identity
    await withTenantTx(db, { schoolId, userId }, (tx) =>
      completeProviderLink(tx, {
        userId,
        schoolId,
        provider: "microsoft",
        subject: claims.sub,
        email: claims.email,
        logger,
      }),
    );
  }

  // 5. Redirect to frontend with success
  const redirectUrl = new URL("/settings/security", frontendUrl);
  redirectUrl.searchParams.set("provider_linked", provider);

  return c.redirect(redirectUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exchangeCode(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<string> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });
  } catch {
    throw new HTTPException(502, { message: "Failed to reach OAuth token endpoint" });
  }

  if (!tokenResponse.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }

  const tokenData = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    throw new HTTPException(502, { message: "OAuth provider did not return an id_token" });
  }

  return tokenData.id_token;
}
