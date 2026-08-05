import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { AI_DEFAULT_RESERVE_TOKENS, AI_MONTHLY_TOKEN_BUDGET } from "../config";

import type { AuthContext } from "../../../middleware/authContext";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiEntitlement, SchoolEntitlement } from "../../subscriptions/entitlements/resolve";
import type { EntitlementService } from "../../subscriptions/entitlements/service";
import type {
  AiReservation,
  AiReservationResult,
  AiSettleResult,
  AiTokenMeter,
} from "../usage/meter";
import type { Context, MiddlewareHandler } from "hono";

/**
 * AI entitlement and quota gate (ST-155).
 *
 * Enforces the decision flow in front of every `/api/ai/*` route, one distinct HTTP status per
 * stage so a client can branch on exactly why a request was refused:
 *
 *   1. school active             -> 403 AI_SCHOOL_INACTIVE
 *   2. student's AI add-on active -> 402 AI_SUBSCRIPTION_INACTIVE
 *   3. quota available            -> 429 AI_QUOTA_EXCEEDED (with Retry-After)
 *
 * Quota is checked by reserving `defaultReserveTokens` from the Redis-metered monthly budget
 * (`modules/ai/usage/meter.ts`) and attaching an `aiQuota` handle to the request context. The
 * handler `commit`s the tokens it actually consumed; if it throws or never settles, the gate
 * `release`s the hold in a finally block so an error cannot leak a reservation.
 *
 * Staleness: the entitlement cache is populated with the AI billing period by the resolver. An
 * entry written before that (a deploy that adds this gate) can be `active` yet period-less for up
 * to the cache TTL; the safe answer until it refills is fail-closed 503 AI_QUOTA_UNAVAILABLE.
 *
 * The meter is a hard dependency: unlike rate limiting, which is fail-open, quota must never be
 * spent while the ledger cannot see it. A Redis failure here answers 503 AI_QUOTA_UNAVAILABLE
 * rather than admitting the request unbilled.
 */

export interface AiQuotaHandle {
  reservationId: string;
  /** Tokens this request is holding while it runs. */
  reservedTokens: number;
  /** True once the reservation was settled by commit() or release(). */
  settled: boolean;
  /** Move this request's hold into used tokens. Idempotent. */
  commit(consumedTokens: number): Promise<AiSettleResult>;
  /** Return this request's hold to the budget without counting it as usage. Idempotent. */
  release(): Promise<AiSettleResult>;
}

/** What the gate resolved for the request: the entitlement verdicts and the budget in force. */
export interface AiEntitlementContext {
  schoolId: string;
  studentId: string;
  school: SchoolEntitlement;
  ai: AiEntitlementVerdict;
  /** The monthly token budget applied to this subscription. */
  budget: number;
}

/**
 * An AI verdict that has passed the period-freshness check, so the meter's billing window is
 * guaranteed present. The intersection narrows the resolver's nullable period fields; assertAiEntitled
 * only returns a context after throwing on a period-less verdict.
 */
export type AiEntitlementVerdict = AiEntitlement & {
  currentPeriodStart: string;
  currentPeriodEnd: string;
};

export interface AiQuotaGateOptions {
  /** The ST-133 entitlement resolver. Only `school` and `ai` are consumed. */
  entitlements: Pick<EntitlementService, "school" | "ai">;
  /** The Redis token meter that backs the quota decision. */
  meter: AiTokenMeter;
  /** Monthly token budget applied unless a plan supplies its own. */
  monthlyTokenBudget?: number;
  /** Tokens reserved up front per request. */
  defaultReserveTokens?: number;
  /**
   * Which student's quota the request draws on. Defaults to the `:studentId` path parameter (or, when
   * the gate is mounted via app.use where Hono exposes no route params, the /api/ai/students/{id}
   * path segment), the shape the AI chat routes will use.
   */
  resolveStudentId?: (c: Context<AppEnv>) => string | null | undefined;
  /**
   * Whether this request should consume quota. Defaults to all `/api/ai/*` paths except the usage
   * endpoint, which reads quota without drawing on it. Pass-through requests skip the gate entirely,
   * so a route that wants the gate's entitlement verdict must assert it itself.
   */
  reserveQuota?: (c: Context<AppEnv>) => boolean;
}

function defaultResolveStudentId(c: Context<AppEnv>): string | undefined {
  // Registered as per-route middleware (app.post(path, gate, handler)) the param is available. But
  // app.use("/api/ai/*", gate) matches the middleware against its own pattern, which has no named
  // params, so Hono exposes none here; fall back to the student-scoped path shape the AI routes
  // share: /api/ai/students/{studentId}/...
  return c.req.param("studentId") ?? /^\/api\/ai\/students\/([^/]+)/.exec(c.req.path)?.[1];
}

function defaultReserveQuota(c: Context<AppEnv>): boolean {
  return !c.req.path.endsWith("/usage");
}

/**
 * The decision-flow assertion behind both the middleware and the usage route.
 *
 * Exported so the usage endpoint and future AI routes can re-assert entitlement when mounted
 * without the gate, and so handlers can resolve their own verdicts without duplicating the stage
 * mapping above.
 */
export async function assertAiEntitled(
  auth: AuthContext,
  deps: { entitlements: Pick<EntitlementService, "school" | "ai"> },
  studentId: string,
  budget: number,
  locale: SupportedLocale = "en",
): Promise<AiEntitlementContext> {
  const [school, ai] = await Promise.all([
    deps.entitlements.school(auth.schoolId),
    deps.entitlements.ai(auth.schoolId, studentId),
  ]);

  if (!school.active) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AI_SCHOOL_INACTIVE,
      getLocalizedMessage(ERROR_CODES.AI_SCHOOL_INACTIVE, locale),
    );
  }

  if (!ai.active) {
    throw new CodedHttpException(
      402,
      ERROR_CODES.AI_SUBSCRIPTION_INACTIVE,
      getLocalizedMessage(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE, locale),
    );
  }

  if (!ai.currentPeriodStart || !ai.currentPeriodEnd) {
    throw new CodedHttpException(
      503,
      ERROR_CODES.AI_QUOTA_UNAVAILABLE,
      getLocalizedMessage(ERROR_CODES.AI_QUOTA_UNAVAILABLE, locale),
    );
  }

  return {
    schoolId: auth.schoolId,
    studentId,
    school,
    ai: ai as AiEntitlementVerdict,
    budget,
  };
}

function createHandle(
  ctx: AiEntitlementContext,
  meter: AiTokenMeter,
  reservation: AiReservation,
): AiQuotaHandle {
  const base = {
    schoolId: ctx.schoolId,
    studentId: ctx.studentId,
    periodStart: ctx.ai.currentPeriodStart,
    periodEnd: ctx.ai.currentPeriodEnd,
    reservationId: reservation.reservationId,
    budget: ctx.budget,
  };

  const handle: AiQuotaHandle = {
    reservationId: reservation.reservationId,
    reservedTokens: reservation.reservedTokens,
    settled: false,
    async commit(consumedTokens) {
      const result = await meter.commit({ ...base, consumedTokens });
      if (result.settled) handle.settled = true;
      return result;
    },
    async release() {
      const result = await meter.release(base);
      if (result.settled) handle.settled = true;
      return result;
    },
  };

  return handle;
}

/**
 * Read the quota handle the gate attached. Throws when the request did not go through the gate with
 * a reservation, which is a server-side wiring error, not a client error.
 */
export function getAiQuota(c: Context<AppEnv>): AiQuotaHandle {
  const handle = c.get("aiQuota");
  if (!handle) {
    throw new Error("ai quota handle missing: request did not pass through aiEntitlementGate");
  }
  return handle;
}

export function aiEntitlementGate(options: AiQuotaGateOptions): MiddlewareHandler<AppEnv> {
  const {
    entitlements,
    meter,
    monthlyTokenBudget = AI_MONTHLY_TOKEN_BUDGET,
    defaultReserveTokens = AI_DEFAULT_RESERVE_TOKENS,
    resolveStudentId = defaultResolveStudentId,
    reserveQuota = defaultReserveQuota,
  } = options;

  return async (c, next) => {
    const auth = requireAuth(c);
    const log = c.get("log");
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    // The usage endpoint reads the budget without drawing on it and re-asserts entitlement itself
    // (routes/usage-routes.ts), so it passes straight through: no student id, no reservation.
    // Checked first so the pass-through path never requires a student id.
    if (!reserveQuota(c)) {
      await next();
      return;
    }

    const studentId = resolveStudentId(c);
    if (!studentId) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        "Missing student id for AI quota resolution",
      );
    }

    const ctx = await assertAiEntitled(
      auth,
      { entitlements },
      studentId,
      monthlyTokenBudget,
      locale,
    );
    c.set("aiEntitlement", ctx);

    let reservation: AiReservationResult;
    try {
      reservation = await meter.reserve({
        schoolId: ctx.schoolId,
        studentId,
        periodStart: ctx.ai.currentPeriodStart,
        periodEnd: ctx.ai.currentPeriodEnd,
        budget: ctx.budget,
        amount: defaultReserveTokens,
      });
    } catch (err) {
      log?.warn({ err, school_id: ctx.schoolId, student_id: studentId }, "ai quota reserve failed");
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_QUOTA_UNAVAILABLE,
        getLocalizedMessage(ERROR_CODES.AI_QUOTA_UNAVAILABLE, locale),
      );
    }

    if (!reservation.ok) {
      c.header("Retry-After", String(reservation.retryAfterSeconds));
      c.header("X-Ai-Quota-Remaining", "0");
      throw new CodedHttpException(
        429,
        ERROR_CODES.AI_QUOTA_EXCEEDED,
        getLocalizedMessage(ERROR_CODES.AI_QUOTA_EXCEEDED, locale),
      );
    }

    const handle = createHandle(ctx, meter, reservation);
    c.set("aiQuota", handle);

    try {
      await next();
    } finally {
      // A handler that never settles the reservation (an error, or an early return) must not leave
      // its hold on the budget. Release failure is logged, never rethrown: the request is already
      // over, and a stuck hold self-heals at the period boundary via the key TTL.
      if (!handle.settled) {
        await handle.release().catch((err) => {
          log?.warn(
            { err, school_id: ctx.schoolId, student_id: studentId },
            "ai quota release failed",
          );
        });
      }
    }
  };
}
