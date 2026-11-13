import { createAppleStore } from "./apple";
import { createGooglePlayStore } from "./google";

import type { StoreBilling } from "./service";

export { aiStoreRoutes } from "./routes";
export type { StoreBilling } from "./service";

/**
 * Build the in-app purchase setup from the environment. Null when no store is configured (the
 * routes still register and answer 503, like the Stripe/Tap ones). env.ts has already checked that
 * the values come in complete sets.
 */
export function createStoreBilling(env: {
  AI_STORE_PRODUCT_ID?: string;
  APPLE_IAP_BUNDLE_ID?: string;
  APPLE_IAP_APP_APPLE_ID?: number;
  GOOGLE_PLAY_PACKAGE_NAME?: string;
  GOOGLE_PLAY_SERVICE_ACCOUNT?: string;
  GOOGLE_PLAY_RTDN_TOKEN?: string;
  NODE_ENV?: string;
}): StoreBilling | null {
  if (!env.AI_STORE_PRODUCT_ID) return null;
  const apple = env.APPLE_IAP_BUNDLE_ID
    ? createAppleStore({
        bundleId: env.APPLE_IAP_BUNDLE_ID,
        appAppleId: env.APPLE_IAP_APP_APPLE_ID,
        // Revocation checks reach Apple's OCSP responder; local development may be offline.
        onlineChecks: env.NODE_ENV === "production",
      })
    : null;
  const google =
    env.GOOGLE_PLAY_PACKAGE_NAME && env.GOOGLE_PLAY_SERVICE_ACCOUNT
      ? createGooglePlayStore({
          packageName: env.GOOGLE_PLAY_PACKAGE_NAME,
          serviceAccountJson: env.GOOGLE_PLAY_SERVICE_ACCOUNT,
        })
      : null;
  if (!apple && !google) return null;
  return {
    productId: env.AI_STORE_PRODUCT_ID,
    apple,
    google,
    googleNotificationToken: env.GOOGLE_PLAY_RTDN_TOKEN ?? null,
  };
}
