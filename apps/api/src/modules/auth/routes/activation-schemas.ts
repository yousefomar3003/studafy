import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const activationPathParams = z
  .object({
    // Format validation is performed inside the activation service, not here: a Zod path error
    // retains the rejected value, and the invitation token is a bearer credential that must never be
    // serialized into an error body or log line. Mirrors the invitation verification endpoint.
    token: z.string().openapi({
      param: { name: "token", in: "path" },
      description: "One-time invitation bearer token (64 lowercase hexadecimal characters).",
      example: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    }),
  })
  .openapi("ActivationPathParams");

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const activationBodySchema = z
  .object({
    id_token: z
      .string()
      .min(1)
      .openapi({
        description:
          "The OIDC ID token obtained by the client's authorization request. It is " +
          "verified server-side against the provider's JWKS before activation proceeds.",
        example: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIs...",
      }),
    nonce: z
      .string()
      .min(1)
      .openapi({
        description:
          "The nonce the client generated for its OIDC authorization request. The ID token is " +
          "rejected unless it was minted with this nonce.",
        example: "n-0S6_WzA2Mj",
      }),
    provider: z
      .enum(["microsoft", "google"])
      .default("microsoft")
      .openapi({
        description:
          "The OAuth provider that issued the id_token. Determines which JWKS is used for " +
          "validation.",
        example: "microsoft",
      }),
  })
  .openapi("ActivateAccountRequest");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const activationResponseSchema = z
  .object({
    status: z.literal("active").openapi({
      description: "The account was provisioned and activated.",
    }),
    access_token: z.string().openapi({ description: "Signed JWT access token." }),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().openapi({
      description: "Access-token lifetime in seconds.",
    }),
    session_id: z.string().uuid().openapi({ description: "Identifier of the new session." }),
    refresh_token: z
      .string()
      .optional()
      .openapi({
        description:
          "Opaque refresh token. Present only for non-web channels; web sessions receive it as an " +
          "HttpOnly cookie instead.",
      }),
  })
  .openapi("ActivateAccountResponse");
