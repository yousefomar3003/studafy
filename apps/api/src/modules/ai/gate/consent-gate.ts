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
/**
 * A consent verdict already read for this request, keyed by the request itself. The student-self
 * gate runs first on every per-student route; when that route also calls the model it reads the
 * consent in the same transaction as the self check and leaves the verdict here, so one request
 * opens one transaction for both gates instead of two. Never carried across requests: a
 * withdrawal takes effect on the very next request, on every API instance.
 */
const prefetchedConsent = new WeakMap<Request, boolean>();

export function rememberConsentVerdict(request: Request, consented: boolean): void {
  prefetchedConsent.set(request, consented);
}

export function aiConsentGate(deps: { database: Database }): MiddlewareHandler<AppEnv> {
  const { database } = deps;

  return async (c, next) => {
    if (!isAiModelCallPath(c.req.path)) {
      await next();
      return;
    }

    const auth = requireAuth(c);
    const consented =
      prefetchedConsent.get(c.req.raw) ??
      (await withTenantTx(
        database,
        { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
        async (tx) => (await findCurrentConsent(tx, auth.userId)) !== null,
      ));

    if (!consented) {
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
