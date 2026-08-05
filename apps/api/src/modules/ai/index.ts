/**
 * AI module (ST-155): entitlement gate, Redis token meter, and usage endpoint for `/api/ai/*`.
 *
 * The gate enforces school active -> AI add-on active -> quota available with distinct HTTP codes
 * (403 / 402 / 429); the meter is the atomic Redis ledger that backs the quota decision; the usage
 * route reports the remaining budget.
 */

export { AI_DEFAULT_RESERVE_TOKENS, AI_MONTHLY_TOKEN_BUDGET } from "./config";
export {
  aiEntitlementGate,
  assertAiEntitled,
  getAiQuota,
  type AiEntitlementContext,
  type AiQuotaGateOptions,
  type AiQuotaHandle,
} from "./gate/entitlement-gate";
export { aiUsageRoutes } from "./routes/usage-routes";
export {
  createAiTokenMeter,
  aiQuotaKey,
  aiQuotaPeriodKey,
  type AiCommitInput,
  type AiQuotaRefusal,
  type AiReleaseInput,
  type AiReservation,
  type AiReservationResult,
  type AiReserveInput,
  type AiSettleResult,
  type AiSnapshotInput,
  type AiTokenMeter,
  type AiUsageSnapshot,
} from "./usage/meter";
