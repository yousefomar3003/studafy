/**
 * The in-app purchase routes' guards, without a database or a store.
 *
 * The mirror image of store-payment-channel.test.ts: Stripe/Tap checkout refuses mobile sessions,
 * and registering an App Store / Google Play purchase refuses everything else -- the website never
 * holds a store receipt, and accepting one there would let a web session claim another channel's
 * purchase.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { aiStoreRoutes } from "../store/routes";
import { StoreVerificationError } from "../store/types";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { AuthChannel } from "../../auth/channels";
import type { StoreBilling } from "../store/service";

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

/** Never reached: every request below stops at a guard. */
const database = (() => {
  throw new Error("the database must not be reached");
}) as unknown as Database;

const store: StoreBilling = {
  productId: "studafy_ai_monthly",
  apple: null,
  google: {
    getSubscription: async () => {
      throw new Error("must not be reached");
    },
    acknowledge: async () => undefined,
    parseNotification: () => {
      throw new StoreVerificationError("not a push");
    },
  },
  googleNotificationToken: "rtdn-token-0123456789",
};

function appFor(channel: AuthChannel | null, billing: StoreBilling | null) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    if (channel) {
      c.set("auth", {
        userId: "00000000-0000-4000-8000-000000000001",
        schoolId: "00000000-0000-4000-8000-000000000002",
        roles: [ROLES.STUDENT],
        channel,
        jti: "jti-1",
        entitlementsVer: 1,
        subscriptionStatus: "active",
      });
    }
    c.set("log", silentLogger);
    c.set("requestId", "req-1");
    c.set("locale", "en");
    await next();
  });
  app.route("/", aiStoreRoutes(database, billing, silentLogger));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

const purchase = JSON.stringify({ platform: "google", verificationData: "token" });

function post(app: OpenAPIHono<AppEnv>, path: string, body = "{}"): Promise<Response> {
  return Promise.resolve(
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body }),
  );
}

describe("registering a purchase", () => {
  for (const channel of [AUTH_CHANNELS.WEB, AUTH_CHANNELS.API]) {
    test(`a ${channel} session is CHANNEL_NOT_AUTHORIZED`, async () => {
      const res = await post(
        appFor(channel, store),
        "/api/subscriptions/ai/store/purchases",
        purchase,
      );

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe(ERROR_CODES.CHANNEL_NOT_AUTHORIZED);
    });
  }

  test("answers 503 when no store is configured", async () => {
    const res = await post(
      appFor(AUTH_CHANNELS.MOBILE, null),
      "/api/subscriptions/ai/store/purchases",
      purchase,
    );

    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe(ERROR_CODES.STORE_BILLING_NOT_CONFIGURED);
  });
});

describe("store setup", () => {
  test("reports the add-on as not for sale when no store is configured", async () => {
    const res = await appFor(AUTH_CHANNELS.MOBILE, null).request(
      "/api/subscriptions/ai/store/config",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      productId: null,
      platforms: { apple: false, google: false },
      purchasable: false,
      accountToken: null,
      profileId: null,
    });
  });
});

describe("Google Play notifications", () => {
  test.each([
    ["no token", "/api/subscriptions/webhook/google"],
    ["a wrong token", "/api/subscriptions/webhook/google?token=rtdn-token-9999999999"],
    ["a token of another length", "/api/subscriptions/webhook/google?token=short"],
  ])("are refused with %s", async (_label, path) => {
    const res = await post(appFor(null, store), path);

    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe(ERROR_CODES.STORE_WEBHOOK_INVALID);
  });

  test("with the right token, a body that is not a push is a 400", async () => {
    const res = await post(
      appFor(null, store),
      "/api/subscriptions/webhook/google?token=rtdn-token-0123456789",
    );

    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe(ERROR_CODES.STORE_WEBHOOK_INVALID);
  });
});

describe("App Store notifications", () => {
  test("answer 503 when the App Store is not configured", async () => {
    const res = await post(
      appFor(null, store),
      "/api/subscriptions/webhook/apple",
      JSON.stringify({ signedPayload: "x" }),
    );

    expect(res.status).toBe(503);
  });
});
