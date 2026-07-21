/**
 * Account activation route (ST-078).
 *
 *   POST /api/auth/invitations/{token}/activate
 *
 * Public (no bearer token): the invitation token in the path *is* the credential. The handler
 * verifies the Microsoft OIDC identity supplied in the body, then runs the atomic activation
 * transaction. On success it delivers the first session token pair; on an email divergence it renders
 * the REQUIRES_ADMIN_APPROVAL problem+json. All other failures (invalid/expired/consumed invitation,
 * duplicate identity) surface as problem+json through the global error handler.
 *
 * Identity verification is injected (`deps.verifyMicrosoftIdentity`) so tests can activate without a
 * live Microsoft JWKS; the default delegates to ST-077's `validateMicrosoftIdToken`.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../channels";
import { deliverTokenPair } from "../delivery";
import { getMicrosoftOAuthConfig } from "../oauth/microsoft-config";
import { validateMicrosoftIdToken } from "../oauth/microsoft-id-token";
import { ACTIVATION_PROVIDER, activateAccount } from "../services/activation-service";

import {
  activationBodySchema,
  activationPathParams,
  activationResponseSchema,
} from "./activation-schemas";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

/** A verified Microsoft identity: the IdP subject and the email asserted by the ID token. */
export interface VerifiedMicrosoftIdentity {
  subject: string;
  email: string;
}

export interface ActivationRouteDeps {
  /** Override for the Microsoft identity verifier. Defaults to the real ST-077 ID-token validation. */
  verifyMicrosoftIdentity?: (idToken: string, nonce: string) => Promise<VerifiedMicrosoftIdentity>;
}

async function defaultVerifyMicrosoftIdentity(
  idToken: string,
  nonce: string,
): Promise<VerifiedMicrosoftIdentity> {
  const oauthConfig = getMicrosoftOAuthConfig();
  if (!oauthConfig) {
    throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
  }
  const claims = await validateMicrosoftIdToken(idToken, oauthConfig.clientId, nonce);
  return { subject: claims.sub, email: claims.email };
}

const activateAccountRoute = createRoute({
  method: "post",
  path: "/api/auth/invitations/{token}/activate",
  tags: ["Invitations"],
  operationId: "activateAccount",
  summary: "Activate an account from an invitation",
  description:
    "Completes onboarding for an invited user. Verifies the Microsoft OIDC identity, asserts it " +
    "matches the invitation's bound email, then atomically consumes the invitation, provisions and " +
    "activates the user, links the OAuth identity, and issues the first session token pair. If the " +
    "OIDC email diverges from the invitation, activation is withheld pending administrator approval.",
  security: [],
  request: {
    params: activationPathParams,
    body: {
      required: true,
      content: { "application/json": { schema: activationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Account activated. Returns the first session token pair.",
        schema: activationResponseSchema,
      },
    },
    [400, 401, 403, 409, 429, 500],
  ),
});

/**
 * Build the activation route group.
 *
 * Requires a database and a session-token config (key store + issuer/audience/TTLs), like the OAuth
 * groups it sits beside.
 */
export function activationRoutes(
  db: Database,
  config: SessionTokenConfig,
  _logger: Logger,
  deps: ActivationRouteDeps = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const verifyIdentity = deps.verifyMicrosoftIdentity ?? defaultVerifyMicrosoftIdentity;

  // Declared with the same {token} path string the OpenAPI route uses, matching the sibling
  // invitation routes — the audit-coverage scanner anchors on that exact string. The authoritative
  // audit rows are emitted from inside the activation transaction (activation-service.ts).
  routes.use("/api/auth/invitations/{token}/activate", auditAction("update", "invitations"));

  routes.openapi(activateAccountRoute, async (c) => {
    const { token } = c.req.valid("param");
    const { id_token, nonce } = c.req.valid("json");
    const log = c.get("log");
    const requestId = c.get("requestId");

    const identity = await verifyIdentity(id_token, nonce);

    const result = await activateAccount(db, config, {
      rawToken: token,
      identity: {
        provider: ACTIVATION_PROVIDER,
        subject: identity.subject,
        email: identity.email,
      },
      // Onboarding runs in a browser; the session is a web session (HttpOnly cookie delivery).
      channel: AUTH_CHANNELS.WEB,
      device: { userAgent: c.req.header("user-agent") ?? null },
      requestId,
      logger: log,
    });

    if (result.outcome === "REQUIRES_ADMIN_APPROVAL") {
      throw new CodedHttpException(
        403,
        ERROR_CODES.REQUIRES_ADMIN_APPROVAL,
        "Activation requires administrator approval.",
      );
    }

    const body = deliverTokenPair(c, result.tokens);
    return c.json({ status: "active" as const, ...body }, 200);
  });

  return routes;
}
