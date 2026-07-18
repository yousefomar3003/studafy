import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import type { AppEnv } from "../../../middleware/requestId";
import type { KeyStore } from "../jwt/key-store";

/**
 * JSON Web Key Set endpoint. Serves the public keys that resource servers use to
 * verify RS256 access tokens. Cached by clients; the Cache-Control header suggests
 * a 5-minute TTL — short enough to pick up rotated keys quickly, long enough to
 * avoid thundering herds.
 *
 * This is a plain GET, not OpenAPI-documented via zod-openapi, because the JWKS
 * response schema (RFC 7517) is a well-known standard that does not benefit from
 * our OpenAPI document. The route is mounted unauthenticated.
 */

const jwksSchema = z
  .object({
    keys: z.array(
      z.object({
        kty: z.string(),
        kid: z.string(),
        use: z.literal("sig"),
        alg: z.literal("RS256"),
        n: z.string(),
        e: z.string(),
      }),
    ),
  })
  .openapi("JsonWebKeySet");

const jwksRoute = createRoute({
  method: "get",
  path: "/.well-known/jwks.json",
  tags: ["Auth"],
  operationId: "getJsonWebKeySet",
  summary: "JSON Web Key Set",
  description:
    "Returns the public RSA keys used to verify RS256 access tokens. " +
    "Clients should cache this response and refresh periodically.",
  security: [],
  responses: standardResponses(
    { 200: { description: "The current JSON Web Key Set.", schema: jwksSchema } },
    [500],
  ),
});

export function jwksRoutes(keyStore: KeyStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(jwksRoute, async (c) => {
    const jwks = await keyStore.toJwks();
    // Map jose's all-optional JWK to our strict schema (required fields guaranteed by KeyStore)
    const keys = jwks.keys.map((k) => ({
      kty: k.kty!,
      kid: k.kid!,
      use: "sig" as const,
      alg: "RS256" as const,
      n: k.n!,
      e: k.e!,
    }));
    return c.json({ keys }, 200, {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
    });
  });

  return routes;
}
