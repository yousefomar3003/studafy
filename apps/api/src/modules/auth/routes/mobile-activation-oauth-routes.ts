/**
 * Mobile invitation-activation OAuth routes (ST-215).
 *
 *   GET  /api/auth/invitations/{token}/oauth/{provider}/mobile-start
 *   POST /api/auth/invitations/{token}/oauth/{provider}/mobile-exchange
 *
 * The mobile arm of the same activation flow `activation-oauth-routes.ts` implements for the
 * browser. A browser gets a full-page redirect because the provider round trip needs one and the
 * activation service can set an HttpOnly cookie on the way back; a native app has neither a
 * navigable page to redirect nor a cookie jar worth trusting, so it drives the same PKCE exchange
 * itself against these two JSON endpoints — mirroring `mobile-oauth-routes.ts`'s split from the
 * browser-redirect login routes.
 *
 *   1. `/mobile-start` mints PKCE + nonce + state, binds the invitation token to that state (in the
 *      process-wide store, `flow: "mobile-activation"` — see oauth/state-store.ts), and returns
 *      them as JSON.
 *   2. The app opens its system browser at `/api/auth/oauth/{provider}/mobile-authorize`, which
 *      redirects to the provider with the server's own client and redirect URI. The provider
 *      returns to the server's callback, which exchanges the code, verifies the id_token, and hands
 *      the verified identity to the app as a one-time code via `studafy://auth/callback` (see
 *      oauth/mobile-handoff.ts).
 *   3. The app posts that code + state + nonce to `/mobile-exchange`, which redeems the handoff and
 *      runs the same `activateAccount` transaction the web flow uses — with `channel: "mobile"`, so
 *      `deliverTokenPair` returns the refresh token in the JSON body instead of an HttpOnly cookie
 *      the app could never read.
 *
 * A lifecycle rejection (expired/revoked/consumed/suspended invitation, duplicate identity) and an
 * email-divergence REQUIRES_ADMIN_APPROVAL both surface as ordinary problem+json — there is no
 * redirect to bounce through, so unlike the browser callback this route lets `activateAccount`'s
 * `CodedHttpException` propagate exactly like the web `POST /activate` endpoint does.
 *
 * A third "mock" provider sits alongside Google and Microsoft (ST-247), mirroring
 * `oauth/mobile-oauth-routes.ts`'s own mock addition — dev/E2E only, inert unless
 * `getMockOAuthConfig()` is non-null, and the only provider the Flutter integration_test suite can
 * drive end-to-end without a real Google/Microsoft app registration.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../channels";
import { deliverTokenPair } from "../delivery";
import { getGoogleOAuthConfig } from "../oauth/config";
import { getMicrosoftOAuthConfig } from "../oauth/microsoft-config";
import { redeemHandoff } from "../oauth/mobile-handoff";
import { getMockOAuthConfig } from "../oauth/mock-config";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oauth/pkce";
import { activateAccount } from "../services/activation-service";

import { activationPathParams, activationResponseSchema } from "./activation-schemas";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { StateStore } from "../oauth/state-store";
import type { ActivationProvider } from "../services/activation-service";
import type { SessionTokenConfig } from "../services/session-service";
import type { Context } from "hono";

type Provider = ActivationProvider;

// ---------------------------------------------------------------------------
// Schemas — distinct component names from mobile-oauth-routes.ts's login shapes even though the
// fields line up field-for-field, since they describe a different operation (activation, not
// login) and zod-openapi registers components by that name.
// ---------------------------------------------------------------------------

const invitationMobileStartResponseSchema = z
  .object({
    state: z.string().describe("OAuth state parameter. Pass back in the exchange request."),
    nonce: z.string().describe("OIDC nonce. Pass back in the exchange request."),
    code_challenge: z
      .string()
      .describe("PKCE S256 code_challenge derived from the code_verifier stored server-side."),
  })
  .openapi("ActivateInvitationMobileStartResponse");

const invitationMobileExchangeRequestSchema = z
  .object({
    code: z.string().min(1).describe("Authorization code from the IdP callback."),
    state: z.string().min(1).describe("State parameter returned by the mobile-start endpoint."),
    nonce: z.string().min(1).describe("Nonce returned by the mobile-start endpoint."),
  })
  .openapi("ActivateInvitationMobileExchangeRequest");

// ---------------------------------------------------------------------------
// Route definitions — one static path per provider, matching mobile-oauth-routes.ts rather than
// activation-oauth-routes.ts's dynamic `:provider` segment, since createRoute needs a fixed path
// template per OpenAPI operation.
// ---------------------------------------------------------------------------

function providerLabel(provider: Provider): string {
  if (provider === "google") return "Google";
  if (provider === "microsoft") return "Microsoft";
  return "Mock";
}

function createInvitationMobileStartRoute(provider: Provider) {
  return createRoute({
    method: "get",
    path: `/api/auth/invitations/{token}/oauth/${provider}/mobile-start`,
    tags: ["Invitations"],
    operationId: `activateInvitation${providerLabel(provider)}MobileStart`,
    summary: `Start a mobile ${provider} OAuth session for invitation activation`,
    description:
      `Generates PKCE, state, and nonce parameters for a mobile invitation-activation flow using ` +
      `${provider}, bound to the invitation token in the path. Returns them as JSON so the mobile ` +
      "app can construct the authorization URL and open a system browser. The code_verifier is " +
      "stored server-side keyed by the state parameter.",
    security: [],
    request: { params: activationPathParams },
    responses: standardResponses(
      {
        200: {
          description: "PKCE parameters for the mobile authorization request.",
          schema: invitationMobileStartResponseSchema,
        },
      },
      [400, 404, 429],
    ),
  });
}

function createInvitationMobileExchangeRoute(provider: Provider) {
  return createRoute({
    method: "post",
    path: `/api/auth/invitations/{token}/oauth/${provider}/mobile-exchange`,
    tags: ["Invitations"],
    operationId: `activateInvitation${providerLabel(provider)}MobileExchange`,
    summary: `Exchange a ${provider} authorization code to activate an invitation (mobile)`,
    description:
      `Validates the PKCE state, exchanges the authorization code with ${provider}'s token ` +
      "endpoint, verifies the id_token, and runs the same account-activation transaction as " +
      "POST /api/auth/invitations/{token}/activate — with channel=mobile, so the refresh token is " +
      "returned in the response body instead of an HttpOnly cookie.",
    security: [],
    request: {
      params: activationPathParams,
      body: {
        required: true,
        content: { "application/json": { schema: invitationMobileExchangeRequestSchema } },
      },
    },
    responses: standardResponses(
      {
        200: {
          description: "Account activated. Returns the first session token pair.",
          schema: activationResponseSchema,
        },
      },
      [400, 403, 404, 409, 429, 500],
    ),
  });
}

// ---------------------------------------------------------------------------
// Shared exchange logic
// ---------------------------------------------------------------------------

interface ExchangeInput {
  token: string;
  code: string;
  state: string;
  nonce: string;
}

interface ExchangeSuccessBody {
  status: "active";
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  session_id: string;
  refresh_token?: string;
}

/**
 * Redeem the one-time handoff the provider callback gave the app (oauth/mobile-handoff.ts) and run
 * the activation. The provider's code was already exchanged and its id_token verified by that
 * callback; this checks the handoff answers this app's state, nonce and invitation token.
 */
async function runMobileExchange(
  c: Context<AppEnv>,
  db: Database,
  sessionConfig: SessionTokenConfig,
  stateStore: StateStore,
  provider: Provider,
  logger: Logger,
  input: ExchangeInput,
): Promise<ExchangeSuccessBody> {
  assertProviderConfigured(provider);

  const handoff = await redeemHandoff(stateStore, {
    code: input.code,
    state: input.state,
    nonce: input.nonce,
    provider,
    purpose: "activation",
  });
  if (!handoff || handoff.token !== input.token) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.OAUTH_STATE_INVALID,
      "Invalid or expired activation state",
    );
  }

  const result = await activateAccount(db, sessionConfig, {
    rawToken: input.token,
    identity: { provider, subject: handoff.identity.sub, email: handoff.identity.email },
    channel: AUTH_CHANNELS.MOBILE,
    device: { userAgent: c.req.header("user-agent") ?? null },
    requestId: c.get("requestId"),
    logger,
  });

  if (result.outcome === "REQUIRES_ADMIN_APPROVAL") {
    throw new CodedHttpException(
      403,
      ERROR_CODES.REQUIRES_ADMIN_APPROVAL,
      "Activation requires administrator approval.",
    );
  }

  const body = deliverTokenPair(c, result.tokens);
  return { status: "active" as const, ...body };
}

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the mobile invitation-activation route group.
 *
 * Requires a database, a session-token config, and the process-wide OAuth state store (so
 * /mobile-start, the provider callback and /mobile-exchange may land on different API instances).
 * Public — the invitation token in the path is the credential.
 */
export function mobileActivationOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
  { stateStore }: { stateStore: StateStore },
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  for (const provider of ["google", "microsoft", "mock"] as const) {
    routes.openapi(createInvitationMobileStartRoute(provider), async (c) => {
      const { token } = c.req.valid("param");
      assertProviderConfigured(provider);

      const state = generateState();
      const nonce = generateNonce();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      await stateStore.set(state, {
        flow: "mobile-activation",
        provider,
        codeVerifier,
        nonce,
        token,
      });

      return c.json({ state, nonce, code_challenge: codeChallenge }, 200);
    });

    routes.openapi(createInvitationMobileExchangeRoute(provider), async (c) => {
      const { token } = c.req.valid("param");
      const { code, state, nonce } = c.req.valid("json");
      const body = await runMobileExchange(c, db, config, stateStore, provider, logger, {
        token,
        code,
        state,
        nonce,
      });
      return c.json(body, 200);
    });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertProviderConfigured(provider: Provider): void {
  const configured =
    provider === "google"
      ? getGoogleOAuthConfig()
      : provider === "microsoft"
        ? getMicrosoftOAuthConfig()
        : getMockOAuthConfig();
  if (!configured) {
    throw new HTTPException(404, { message: `${provider} OAuth is not configured` });
  }
}
