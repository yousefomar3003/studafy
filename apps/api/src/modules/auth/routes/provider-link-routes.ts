/**
 * OAuth provider linking routes — lockout resilience (R-03).
 *
 * Self-service and administrative endpoints for linking and unlinking OAuth providers.
 *
 *   GET    /api/auth/providers                           — list linked providers
 *   POST   /api/auth/providers/link/start                 — initiate linking OAuth flow
 *   DELETE /api/auth/providers/{provider}                 — unlink own provider
 *   DELETE /api/admin/users/{userId}/providers/{provider} — admin unlink
 *
 * Linking has no callback of its own. The provider returns the browser to its one registered
 * redirect URI, `/api/auth/oauth/{provider}/callback` (public, under DEFAULT_PUBLIC_PATHS), whose
 * state entry (`flow: "link"`) carries the user binding; that callback verifies the identity and
 * finishes through {@link completeWebLink} below.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../channels";
import { getGoogleOAuthConfig, GOOGLE_AUTH_ENDPOINT, GOOGLE_SCOPES } from "../oauth/config";
import {
  getMicrosoftOAuthConfig,
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
} from "../oauth/microsoft-config";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oauth/pkce";
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
import type { StateStore } from "../oauth/state-store";
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

export interface ProviderLinkDependencies {
  /** The process-wide OAuth state store, shared with the provider callbacks that redeem it. */
  stateStore: StateStore;
}

/**
 * Build the provider-link route group.
 *
 * Requires a database and the shared OAuth state store. The link flow has no callback of its own:
 * the provider returns to its one registered redirect URI (`/api/auth/oauth/{provider}/callback`),
 * which sees `flow: "link"` on the state entry and finishes through {@link completeWebLink}.
 */
export function providerLinkRoutes(
  db: Database,
  { stateStore }: ProviderLinkDependencies,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

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

    await stateStore.set(state, {
      flow: "link",
      provider,
      codeVerifier,
      nonce,
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
  // Channel guard: administrative mutations are restricted to web sessions.
  const adminChannelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/admin/users/:userId/providers/:provider", adminChannelGuard);
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

  return routes;
}

// ---------------------------------------------------------------------------
// Link completion
// ---------------------------------------------------------------------------

export interface WebLinkInput {
  provider: "google" | "microsoft";
  /** The user and school the state entry was bound to at link start. */
  userId: string;
  schoolId: string;
  /** The identity the provider callback has already verified (id_token signature, nonce, audience). */
  identity: { sub: string; email: string };
  frontendUrl: string | undefined;
}

/**
 * Finish a provider link once the provider callback has verified the identity.
 *
 * Errors propagate to the callback, which renders them as the frontend's OAuth error page.
 */
export async function completeWebLink(
  c: Context<AppEnv>,
  db: Database,
  logger: Logger,
  { provider, userId, schoolId, identity, frontendUrl }: WebLinkInput,
): Promise<Response> {
  await withTenantTx(db, { schoolId, userId }, (tx) =>
    completeProviderLink(tx, {
      userId,
      schoolId,
      provider,
      subject: identity.sub,
      email: identity.email,
      logger,
    }),
  );

  const redirectUrl = new URL("/settings/security", frontendUrl ?? "/");
  redirectUrl.searchParams.set("provider_linked", provider);
  return c.redirect(redirectUrl.toString(), 302);
}
