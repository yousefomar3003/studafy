import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getLocalizedMessage } from "../../../middleware/locale";
import { getFeatureGate } from "../../features/middleware";
import { AI_DEFAULT_RESERVE_TOKENS, AI_MONTHLY_TOKEN_BUDGET } from "../config";

import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { FeatureRefusalCodes, RequireFeatureOptions } from "../../features/middleware";
import type {
  AiReservation,
  AiReservationResult,
  AiSettleResult,
  AiTokenMeter,
} from "../usage/meter";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The AI monthly token budget (ST-155), behind `requireFeature` on every AI route that reaches the
 * model or holds quota.
 *
 * `requireFeature` decides whether the student holds the feature and counts its units; this keeps
 * the cost guard it always was -- a monthly token budget per student, metered in Redis
 * (`modules/ai/usage/meter.ts`) and keyed on the billing window of the grant the feature verdict
 * reports. For an AI add-on subscriber that window is the add-on's own, so the Redis key, the budget
 * and every hold size are exactly what the old entitlement gate used.
 *
 * Stages, after requireFeature's 403/402/429:
 *   - verdict without a billing window (cannot key the meter) -> 503 AI_QUOTA_UNAVAILABLE
 *   - Redis failure                                           -> 503 AI_QUOTA_UNAVAILABLE
 *   - budget exhausted                                        -> 429 AI_QUOTA_EXCEEDED (Retry-After)
 *
 * The meter is a hard dependency: unlike rate limiting, which is fail-open, quota must never be
 * spent while the ledger cannot see it.
 *
 * Wiring: app.ts mounts {@link provideAiTokenBudget} on /api/ai/* with the meter and the hold
 * sizing; each route mounts `requireFeature(key, { ...AI_FEATURE_ROUTE })` then `aiTokenBudget()`.
 */

export interface AiQuotaHandle {
  reservationId: string;
  /** Tokens this request is holding while it runs. */
  reservedTokens: number;
  /** True once the reservation was settled by commit() or release(), or handed off by detach(). */
  settled: boolean;
  /** Move this request's hold into used tokens. Idempotent. */
  commit(consumedTokens: number): Promise<AiSettleResult>;
  /** Return this request's hold to the budget without counting it as usage. Idempotent. */
  release(): Promise<AiSettleResult>;
  /**
   * Hand the live reservation off to code that outlives this handler's return.
   *
   * `streamSSE` (hono/streaming) fires its callback without awaiting it and returns the Response
   * immediately, so a streaming route's own async function resolves before its SSE body has written
   * a single byte. The middleware's `finally` block runs right after that resolution -- before the
   * stream has produced anything to commit -- and would release a hold the route fully intends to
   * keep (see docs/rag/ask-ai-streaming-and-prompt-injection.md). `detach()` marks the handle settled
   * from the middleware's point of view, so its `finally` skips the auto-release, WITHOUT touching
   * the reservation itself: it stays live in Redis under the same `reservationId` until the detached
   * caller calls `commit()`/`release()` on this same handle once the stream actually ends. Call it
   * only once success up to the point of opening the stream is certain -- anything that can still
   * fail before that should throw normally and let the middleware release as usual.
   */
  detach(): void;
}

export interface AiTokenBudgetConfig {
  /** The Redis token meter that backs the quota decision. */
  meter: AiTokenMeter;
  /** Monthly token budget per student. */
  monthlyTokenBudget?: number;
  /** Tokens reserved up front per request. */
  defaultReserveTokens?: number;
  /**
   * Resolve the hold size for one request, when the hold is not the default. `undefined` falls back
   * to the default. See app.ts for why the model-calling paths hold the worst case.
   */
  resolveReserveTokens?: (c: Context<AppEnv>) => number | undefined;
}

/**
 * Today's AI refusal codes, kept on the AI routes: the mobile app shipped in the stores branches on
 * AI_SUBSCRIPTION_INACTIVE to show the paywall (features/ai/domain/ai_hub_status.dart and the
 * per-feature controllers). Session 6 moves the clients to the FEATURE_* codes; this mapping is
 * removed once the minimum supported app version reads them.
 */
export const AI_REFUSAL_CODES: FeatureRefusalCodes = {
  schoolInactive: ERROR_CODES.AI_SCHOOL_INACTIVE,
  notIncluded: ERROR_CODES.AI_SUBSCRIPTION_INACTIVE,
  expired: ERROR_CODES.AI_SUBSCRIPTION_INACTIVE,
};

/**
 * The student whose feature and budget an AI route draws on: the `:studentId` path parameter, as
 * the old gate used. Exactly today's access rule -- the gate keys on the student in the path, not
 * on the caller.
 */
export function aiStudentSubject(c: Context<AppEnv>): { studentId: string } | null {
  const studentId =
    c.req.param("studentId") ?? /^\/api\/ai\/students\/([^/]+)/.exec(c.req.path)?.[1];
  return studentId ? { studentId } : null;
}

/** Spread into requireFeature on every AI route: `requireFeature("study_tools", { ...AI_FEATURE_ROUTE, meter: 1 })`. */
export const AI_FEATURE_ROUTE = {
  subject: aiStudentSubject,
  codes: AI_REFUSAL_CODES,
} as const satisfies RequireFeatureOptions;

function createHandle(
  base: {
    schoolId: string;
    studentId: string;
    periodStart: string;
    periodEnd: string;
    budget: number;
  },
  meter: AiTokenMeter,
  reservation: AiReservation,
): AiQuotaHandle {
  const settle = { ...base, reservationId: reservation.reservationId };

  const handle: AiQuotaHandle = {
    reservationId: reservation.reservationId,
    reservedTokens: reservation.reservedTokens,
    settled: false,
    async commit(consumedTokens) {
      const result = await meter.commit({ ...settle, consumedTokens });
      if (result.settled) handle.settled = true;
      return result;
    },
    async release() {
      const result = await meter.release(settle);
      if (result.settled) handle.settled = true;
      return result;
    },
    detach() {
      handle.settled = true;
    },
  };

  return handle;
}

/**
 * Read the quota handle aiTokenBudget attached. Throws when the request did not go through it, which
 * is a server-side wiring error, not a client error.
 */
export function getAiQuota(c: Context<AppEnv>): AiQuotaHandle {
  const handle = c.get("aiQuota");
  if (!handle) {
    throw new Error("ai quota handle missing: request did not pass through aiTokenBudget");
  }
  return handle;
}

/** Puts the budget configuration on /api/ai/* requests, for aiTokenBudget(). */
export function provideAiTokenBudget(config: AiTokenBudgetConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("aiTokenBudget", config);
    await next();
  };
}

export function aiTokenBudget(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // One reservation per request. A request that already holds one (a route mounted under the
    // budget twice, or a route test that injects its own handle) keeps it.
    if (c.get("aiQuota")) {
      await next();
      return;
    }

    const config = c.get("aiTokenBudget");
    if (!config) {
      throw new Error(
        "ai token budget missing: provideAiTokenBudget is not mounted for this route",
      );
    }
    const {
      meter,
      monthlyTokenBudget = AI_MONTHLY_TOKEN_BUDGET,
      defaultReserveTokens = AI_DEFAULT_RESERVE_TOKENS,
      resolveReserveTokens,
    } = config;

    const gate = getFeatureGate(c);
    const log = c.get("log");
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const unavailable = () =>
      new CodedHttpException(
        503,
        ERROR_CODES.AI_QUOTA_UNAVAILABLE,
        getLocalizedMessage(ERROR_CODES.AI_QUOTA_UNAVAILABLE, locale),
      );

    const { periodStart, periodEnd } = gate.access;
    if (!gate.studentId || !periodStart || !periodEnd) throw unavailable();

    const base = {
      schoolId: gate.schoolId,
      studentId: gate.studentId,
      periodStart,
      periodEnd,
      budget: monthlyTokenBudget,
    };

    let reservation: AiReservationResult;
    try {
      reservation = await meter.reserve({
        ...base,
        amount: resolveReserveTokens?.(c) ?? defaultReserveTokens,
      });
    } catch (err) {
      log?.warn(
        { err, school_id: base.schoolId, student_id: base.studentId },
        "ai quota reserve failed",
      );
      throw unavailable();
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

    const handle = createHandle(base, meter, reservation);
    c.set("aiQuota", handle);

    try {
      await next();
    } finally {
      // A handler that never settles the reservation (an error, or an early return) must not leave
      // its hold on the budget. Release failure is logged, never rethrown: the request is already
      // over, and a stuck hold self-heals at the period boundary via the key TTL.
      if (!handle.settled) {
        await handle.release().catch((err: unknown) => {
          log?.warn(
            { err, school_id: base.schoolId, student_id: base.studentId },
            "ai quota release failed",
          );
        });
      }
    }
  };
}
