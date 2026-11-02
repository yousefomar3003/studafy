import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { isAiModelCallPath } from "../consent/disclosure";
import { findCurrentConsent } from "../consent/persistence";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { MiddlewareHandler } from "hono";

/**
 * Third-party AI data-sharing consent gate (ST-305).
 *
 * Mounted on /api/ai/* ahead of the entitlement gate. A request to a route that sends user data to
 * the model provider (`isAiModelCallPath`) is refused with 403 AI_CONSENT_REQUIRED unless the
 * authenticated user holds a live consent to the current disclosure -- before quota is reserved and
 * before the handler can build a prompt, so a refused request sends nothing anywhere. This is the
 * enforcement point for every client (iOS, Android, web); a client-side modal alone could be skipped.
 *
 * Routes that never reach the provider (usage, search, grading, reviews, exam polling, consent
 * itself) pass through untouched.
 */
export function aiConsentGate(deps: { database: Database }): MiddlewareHandler<AppEnv> {
  const { database } = deps;

  return async (c, next) => {
    if (!isAiModelCallPath(c.req.path)) {
      await next();
      return;
    }

    const auth = requireAuth(c);
    const consent = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => findCurrentConsent(tx, auth.userId),
    );

    if (!consent) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AI_CONSENT_REQUIRED,
        getLocalizedMessage(
          ERROR_CODES.AI_CONSENT_REQUIRED,
          (c.get("locale") ?? "en") as SupportedLocale,
        ),
      );
    }

    await next();
  };
}
