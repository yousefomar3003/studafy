import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { standardResponses } from "../../../openapi/responses";
import { getFeatureService } from "../../features/middleware";
import { AI_MONTHLY_TOKEN_BUDGET } from "../config";

import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiTokenMeter } from "../usage/meter";

/**
 * AI quota usage endpoint (ST-155).
 *
 * Reports the authenticated caller's own AI token budget for the current billing period: tokens
 * committed, tokens held by an in-flight request, the monthly budget, and what remains. Reading
 * quota never draws on it.
 *
 * Entitled when the caller holds either AI feature (ai_tutor or study_tools) -- through the AI
 * add-on or any other grant (docs/billing/feature-licensing.md). The budget's window is the grant
 * the active feature reports, the same window aiTokenBudget meters against, so the snapshot reads
 * the counter the AI routes write. The refusals keep the AI routes' codes: 403 AI_SCHOOL_INACTIVE,
 * and 402 AI_SUBSCRIPTION_INACTIVE for a caller with no AI feature (or no student record -- the
 * budget is a student's).
 */

const AI_FEATURE_KEYS = ["ai_tutor", "study_tools"] as const;

const AiUsageResponseSchema = z.object({
  /** False until something has been reserved or committed this period. */
  active: z.boolean(),
  /** Monthly token budget for this subscription's billing period. */
  budget: z.number().int().nonnegative(),
  /** Tokens the period has already consumed. */
  usedTokens: z.number().int().nonnegative(),
  /** Tokens held by an in-flight request. */
  heldTokens: z.number().int().nonnegative(),
  /** Budget not yet used or held. */
  remaining: z.number().int().nonnegative(),
  /** ISO billing window this snapshot covers. */
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

const aiUsageRoute = createRoute({
  method: "get",
  path: "/api/ai/usage",
  tags: ["AI"],
  operationId: "getAiUsage",
  summary: "Get current AI quota usage",
  description:
    "Returns the authenticated caller's AI token usage for the current billing period: " +
    "committed usage, tokens held by an in-flight request, the monthly budget, and what remains. " +
    "Requires an active school and an AI feature (ai_tutor or study_tools); refuses with the same " +
    "codes as the AI routes. Reading usage does not consume quota.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "AI quota usage for the current billing period",
        schema: AiUsageResponseSchema,
      },
    },
    [401, 402, 403, 503],
  ),
});

export function aiUsageRoutes(deps: {
  meter: AiTokenMeter;
  monthlyTokenBudget?: number;
}): OpenAPIHono<AppEnv> {
  const { meter, monthlyTokenBudget = AI_MONTHLY_TOKEN_BUDGET } = deps;
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(aiUsageRoute, async (c) => {
    const auth = requireAuth(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const refuse = (
      status: 402 | 403 | 503,
      code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    ) => new CodedHttpException(status, code, getLocalizedMessage(code, locale));

    const resolved = await getFeatureService(c).resolve(auth.schoolId, { userId: auth.userId });
    const features = AI_FEATURE_KEYS.map((key) => resolved.features[key]);

    if (features.some((feature) => feature.reason === "school_inactive")) {
      throw refuse(403, ERROR_CODES.AI_SCHOOL_INACTIVE);
    }

    // The latest-ending window, as both features of one grant share one.
    const active = features
      .filter((feature) => feature.active)
      .sort((a, b) => Date.parse(b.periodEnd ?? "") - Date.parse(a.periodEnd ?? ""))[0];
    if (!resolved.studentId || !active) throw refuse(402, ERROR_CODES.AI_SUBSCRIPTION_INACTIVE);
    if (!active.periodStart || !active.periodEnd)
      throw refuse(503, ERROR_CODES.AI_QUOTA_UNAVAILABLE);

    const snapshot = await meter.snapshot({
      schoolId: auth.schoolId,
      studentId: resolved.studentId,
      periodStart: active.periodStart,
      periodEnd: active.periodEnd,
      budget: monthlyTokenBudget,
    });

    return c.json(snapshot, 200);
  });

  return app;
}
