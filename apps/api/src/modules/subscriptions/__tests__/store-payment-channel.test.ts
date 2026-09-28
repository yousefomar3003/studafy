/**
 * Store-compliant payment routing, server half (ST-304).
 *
 * Every route that starts, manages or cancels a paid digital subscription must refuse a session that
 * was not established on the web: the App Store and Google Play only allow digital goods to be sold
 * inside a native app through their own in-app purchase, so the mobile token surface must not be
 * able to open a Stripe/Tap session at all — whatever the mobile client does or doesn't render. The
 * client half (no purchase link anywhere in the app) is pinned by apps/mobile's
 * `test/store_compliance/payment_routing_test.dart`; see apps/mobile/docs/store_payment_routing.md.
 *
 * School-fee payments (`/api/finance/*`) are deliberately not listed: fees pay for a real-world
 * service, which both stores exempt from in-app purchase.
 *
 * The guard runs before body validation, so a web session sending an empty body reaching `400`
 * proves the channel check let it through without needing a database or a payment provider.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { aiCheckoutRoutes } from "../routes/ai-checkout-routes";
import { cancellationRoutes } from "../routes/cancellation-routes";
import { checkoutRoutes } from "../routes/checkout-routes";
import { schoolCheckoutRoutes } from "../routes/school-checkout-routes";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { AuthChannel } from "../../auth/channels";
import type { PaymentProviderRegistry } from "../payment-provider-routing";

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

/** Never reached: every request below stops at the channel guard or body validation. */
const database = (() => {
  throw new Error("the database must not be reached");
}) as unknown as Database;
const providers: PaymentProviderRegistry = { stripe: null, tap: null };

const PURCHASE_ROUTES: string[] = [
  "/api/subscriptions/checkout",
  "/api/subscriptions/portal",
  "/api/subscriptions/school/checkout",
  "/api/subscriptions/ai/checkout",
  "/api/subscriptions/current/cancel",
  "/api/subscriptions/current/cancel/reverse",
];

function appFor(channel: AuthChannel): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", {
      userId: "00000000-0000-4000-8000-000000000001",
      schoolId: "00000000-0000-4000-8000-000000000002",
      roles: [ROLES.ORG_ADMIN],
      channel,
      jti: "jti-1",
      entitlementsVer: 1,
      subscriptionStatus: "active",
    });
    c.set("log", silentLogger);
    c.set("requestId", "req-1");
    c.set("locale", "en");
    await next();
  });
  app.route("/", checkoutRoutes(database, providers));
  app.route("/", schoolCheckoutRoutes(database, providers));
  app.route("/", aiCheckoutRoutes(database, providers));
  app.route("/", cancellationRoutes(database, providers));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

function post(app: OpenAPIHono<AppEnv>, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
}

describe("purchase routes refuse non-web sessions", () => {
  for (const channel of [AUTH_CHANNELS.MOBILE, AUTH_CHANNELS.API]) {
    test.each(PURCHASE_ROUTES)(
      `${channel} session: POST %s is CHANNEL_NOT_AUTHORIZED`,
      async (path) => {
        const res = await post(appFor(channel), path);

        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe(
          ERROR_CODES.CHANNEL_NOT_AUTHORIZED,
        );
      },
    );
  }

  test.each(PURCHASE_ROUTES)("web session: POST %s passes the channel guard", async (path) => {
    const res = await post(appFor(AUTH_CHANNELS.WEB), path);

    expect(res.status).not.toBe(403);
  });
});
