/**
 * Channel-based authorization guard.
 *
 * Restricts which session channels may reach a route. The channel is a property of the session
 * established at login and carried in every access token — it cannot be changed by the caller
 * after issuance (see modules/auth/channels.ts for why headers are deliberately ignored).
 *
 * The primary use case is web-only admin mutations: administrative routes that should only be
 * reachable from a browser session, never from a long-lived mobile or API token. This is the
 * same pattern as requirePermission in authz.ts — a generic factory that names the allowed
 * channel, logs the denial, and throws a coded HTTP exception that travels through the standard
 * error envelope.
 *
 * Unlike role-based permission checks, the channel check is not about what the caller may do
 * but about how the session was established. An ORG_ADMIN on a mobile token holds every
 * permission the role grants, but the channel policy still refuses the request because the
 * threat model is the token surface, not the role.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../coded-http-exception";

import { requireAuth } from "./authContext";

import type { AppEnv } from "./requestId";
import type { AuthChannel } from "../modules/auth/channels";
import type { MiddlewareHandler } from "hono";

/**
 * Refuse the request unless the caller's session was established on an allowed channel.
 *
 * Runs after jwtAuth.ts has established identity — it reads the context that middleware populates —
 * so it must be mounted on a path already inside the `/api/*` authentication boundary.
 *
 * When the channel is not allowed, the response carries `CHANNEL_NOT_AUTHORIZED` rather than the
 * generic `AUTHZ_FORBIDDEN` so clients and monitoring can distinguish a channel policy denial
 * from a role-based one. The detail message is localized through the standard envelope.
 */
export function requireChannel(...allowed: AuthChannel[]): MiddlewareHandler<AppEnv> {
  const allowedSet = new Set<AuthChannel>(allowed);

  return async (c, next) => {
    const auth = requireAuth(c);

    if (!allowedSet.has(auth.channel)) {
      c.get("log").warn(
        {
          event: "channel_denied",
          allowed_channels: [...allowed],
          actual_channel: auth.channel,
          route: c.req.path,
          actor_roles: auth.roles,
        },
        "caller session channel is not authorized for this route",
      );

      throw new CodedHttpException(
        403,
        ERROR_CODES.CHANNEL_NOT_AUTHORIZED,
        "This operation is not available from this client",
      );
    }

    await next();
  };
}
