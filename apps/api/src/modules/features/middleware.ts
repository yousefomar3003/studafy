import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { requireAuth } from "../../middleware/authContext";
import { getLocalizedMessage } from "../../middleware/locale";

import { secondsUntilNextUsagePeriod } from "./resolve";

import type { FeatureAccess } from "./resolve";
import type { FeatureService, FeatureSubject } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { ErrorCode, FeatureKey } from "@studafy/constants";
import type { Context, MiddlewareHandler } from "hono";

/**
 * `requireFeature("<key>")`: the one gate in front of every paid feature's routes
 * (docs/billing/feature-licensing.md).
 *
 *   1. school active                      -> 403 AI_SCHOOL_INACTIVE (today's code and status)
 *   2. feature active for the person      -> 402 FEATURE_NOT_INCLUDED / FEATURE_EXPIRED
 *   3. `meter` units within the month     -> 429 FEATURE_LIMIT_REACHED (Retry-After: next 1st, UTC)
 *
 * Units are consumed before the handler runs, so two concurrent requests cannot both take the last
 * one, and given back when the handler fails (an error or a 4xx/5xx answer). The verdict is left on
 * the context for what runs after: the AI token budget (modules/ai/gate) reads its billing window.
 *
 * The service comes from the context (`provideFeatures`, mounted once in app.ts), so a route only
 * names its feature: `routes.use("/api/thing/:id", requireFeature("thing", { meter: 1 }))`.
 */

export interface FeatureGateContext {
  key: FeatureKey;
  schoolId: string;
  userId: string;
  /** The person's student record, or null for a non-student. */
  studentId: string | null;
  access: FeatureAccess;
}

/** The codes a refusal answers with. Overridable for a surface whose clients predate the gate. */
export interface FeatureRefusalCodes {
  schoolInactive: ErrorCode;
  notIncluded: ErrorCode;
  expired: ErrorCode;
}

export const FEATURE_REFUSAL_CODES: FeatureRefusalCodes = {
  schoolInactive: ERROR_CODES.AI_SCHOOL_INACTIVE,
  notIncluded: ERROR_CODES.FEATURE_NOT_INCLUDED,
  expired: ERROR_CODES.FEATURE_EXPIRED,
};

export interface RequireFeatureOptions {
  /** Units this request uses. Omitted or 0: checked, not counted. */
  meter?: number;
  /** Whose feature. Defaults to the signed-in user. */
  subject?: (c: Context<AppEnv>) => FeatureSubject | null;
  /** Override the refusal codes (statuses are fixed). */
  codes?: FeatureRefusalCodes;
}

/** Puts the feature service on every request, for requireFeature and GET /api/me/features. */
export function provideFeatures(service: FeatureService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("features", service);
    await next();
  };
}

export function getFeatureService(c: Context<AppEnv>): FeatureService {
  const service = c.get("features");
  if (!service) {
    throw new Error("feature service missing: provideFeatures is not mounted for this route");
  }
  return service;
}

/** The verdict requireFeature attached. Throws on a route that is not behind requireFeature. */
export function getFeatureGate(c: Context<AppEnv>): FeatureGateContext {
  const gate = c.get("featureGate");
  if (!gate) throw new Error("feature gate missing: the route is not behind requireFeature");
  return gate;
}

function refuse(
  c: Context<AppEnv>,
  status: 402 | 403 | 422 | 429,
  code: ErrorCode,
): CodedHttpException {
  const locale = (c.get("locale") ?? "en") as SupportedLocale;
  return new CodedHttpException(status, code, getLocalizedMessage(code, locale));
}

export function requireFeature(
  key: FeatureKey,
  options: RequireFeatureOptions = {},
): MiddlewareHandler<AppEnv> {
  const { meter = 0, codes = FEATURE_REFUSAL_CODES } = options;
  if (!Number.isInteger(meter) || meter < 0) {
    throw new Error(`requireFeature("${key}"): meter must be a non-negative integer`);
  }

  return async (c, next) => {
    const auth = requireAuth(c);
    const service = getFeatureService(c);
    const log = c.get("log");

    const subject = options.subject ? options.subject(c) : { userId: auth.userId };
    if (!subject) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        `Missing subject for feature ${key}`,
      );
    }

    const resolved = await service.resolve(auth.schoolId, subject);
    const access = resolved.features[key];

    if (!access.active) {
      if (access.reason === "school_inactive") throw refuse(c, 403, codes.schoolInactive);
      if (access.reason === "expired") throw refuse(c, 402, codes.expired);
      throw refuse(c, 402, codes.notIncluded);
    }
    // Active implies a covering grant, which implies a known person.
    const userId = resolved.userId!;

    let consumed: { periodStart: string } | null = null;
    if (meter > 0) {
      const result = await service.usage.consume({
        schoolId: auth.schoolId,
        userId,
        key,
        amount: meter,
        limit: access.limit,
        requestId: c.get("requestId"),
      });
      if (!result.ok) {
        c.header("Retry-After", String(secondsUntilNextUsagePeriod(new Date())));
        throw refuse(c, 429, ERROR_CODES.FEATURE_LIMIT_REACHED);
      }
      consumed = { periodStart: result.periodStart };
      access.used = result.used;
    }

    c.set("featureGate", {
      key,
      schoolId: auth.schoolId,
      userId,
      studentId: resolved.studentId,
      access,
    });

    let succeeded = false;
    try {
      await next();
      succeeded = c.res.status < 400;
    } finally {
      // Logged, never rethrown: the request is over, and an unrefunded unit is the person's loss of
      // one unit for the month, not a correctness problem for anyone else.
      if (consumed && !succeeded) {
        await service.usage
          .refund({
            schoolId: auth.schoolId,
            userId,
            key,
            amount: meter,
            periodStart: consumed.periodStart,
            requestId: c.get("requestId"),
          })
          .catch((err: unknown) => {
            log?.warn(
              { err, school_id: auth.schoolId, user_id: userId, feature: key },
              "feature usage refund failed",
            );
          });
      }
    }
  };
}
