import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { requireAuth } from "../../middleware/authContext";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { mintRealtimeTicket } from "./ticket";

import type { AppEnv } from "../../middleware/requestId";

const realtimeTicketSchema = z
  .object({
    ticket: z.string().openapi({
      description:
        "Pass as the `ticket` query parameter of the realtime gateway's `/ws` handshake. Single use.",
    }),
    expires_at: z.string().datetime().openapi({
      description: "The handshake must start before this instant. The socket itself lives longer.",
    }),
  })
  .openapi("RealtimeTicket");

const realtimeTicketRoute = createRoute({
  method: "get",
  path: "/api/realtime/ticket",
  tags: ["Realtime"],
  operationId: "getRealtimeTicket",
  summary: "Mint a realtime handshake ticket",
  description:
    "A short-lived (30 s), single-use credential for opening one socket to the realtime gateway, so " +
    "the access token itself never appears in a WebSocket URL. Ask for a fresh ticket on every " +
    "connection attempt, including the reconnect after a `4401` close. The socket stays open until " +
    "the access token used here expires or its session is revoked. A GET with no server-side " +
    "state, sent `Cache-Control: no-store`.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "A ticket for the caller's session.", schema: realtimeTicketSchema } },
    [401, 429, 500],
  ),
});

/** Realtime ticket issuance (QA-14). `secret` is env.WS_JWT_SECRET, shared with the gateway. */
export function realtimeTicketRoutes(secret: string): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(realtimeTicketRoute, async (c) => {
    const auth = requireAuth(c);
    const { ticket, expiresAt } = await mintRealtimeTicket(
      {
        userId: auth.userId,
        schoolId: auth.schoolId,
        roles: auth.roles,
        accessTokenJti: auth.jti,
        accessTokenExp: auth.exp,
      },
      secret,
    );
    return c.json({ ticket, expires_at: expiresAt.toISOString() }, 200, {
      "Cache-Control": "no-store",
    });
  });

  return routes;
}
