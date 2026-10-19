import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { standardResponses } from "../../../openapi/responses";
import { AI_MONTHLY_TOKEN_BUDGET } from "../config";
import { assertAiEntitled } from "../gate/entitlement-gate";

import type { Database } from "../../../db/client";
import type { AuthContext } from "../../../middleware/authContext";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { EntitlementService } from "../../subscriptions/entitlements/service";
import type { AiTokenMeter } from "../usage/meter";

/**
 * AI quota usage endpoint (ST-155).
 *
 * Reports the authenticated caller's own AI quota for the current billing period: tokens committed,
 * tokens held by an in-flight request, the monthly budget, and what remains. It rides the same
 * decision flow as the gate -- school active, AI add-on active -- so an unentitled caller gets the
 * same 403/402 codes as any other AI surface instead of a peek at someone else's budget. Reading
 * quota never draws on it.
 *
 * The route takes no studentId, so it looks up the caller's own `app.students` row: AI add-ons and
 * meters are keyed by the student id, which is not the user id the session carries. A caller with
 * no student record has no AI add-on and answers 402 AI_SUBSCRIPTION_INACTIVE.
 */

/** The student record of a signed-in user, or null for a user who is not a student. */
export type StudentIdResolver = (auth: AuthContext, requestId?: string) => Promise<string | null>;

export function databaseStudentIdResolver(database: Database): StudentIdResolver {
  return async (auth, requestId) =>
    withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId },
      async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          SELECT id FROM app.students WHERE user_id = ${auth.userId}::uuid LIMIT 1
        `;
        return row?.id ?? null;
      },
    );
}

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
    "Requires an active school subscription and AI add-on; refuses with the same codes as the AI " +
    "gate. Reading usage does not consume quota.",
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
  entitlements: Pick<EntitlementService, "school" | "ai">;
  meter: AiTokenMeter;
  /** Maps the session's user to their student record (`databaseStudentIdResolver` in the app). */
  studentIdFor: StudentIdResolver;
  monthlyTokenBudget?: number;
}): OpenAPIHono<AppEnv> {
  const { entitlements, meter, studentIdFor, monthlyTokenBudget = AI_MONTHLY_TOKEN_BUDGET } = deps;
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(aiUsageRoute, async (c) => {
    const auth = requireAuth(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const studentId = await studentIdFor(auth, c.get("requestId"));
    if (!studentId) {
      throw new CodedHttpException(
        402,
        ERROR_CODES.AI_SUBSCRIPTION_INACTIVE,
        getLocalizedMessage(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE, locale),
      );
    }
    const ctx = await assertAiEntitled(
      auth,
      { entitlements },
      studentId,
      monthlyTokenBudget,
      locale,
    );

    const snapshot = await meter.snapshot({
      schoolId: ctx.schoolId,
      studentId: ctx.studentId,
      periodStart: ctx.ai.currentPeriodStart,
      periodEnd: ctx.ai.currentPeriodEnd,
      budget: ctx.budget,
    });

    return c.json(snapshot, 200);
  });

  return app;
}
