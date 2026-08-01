/**
 * Payment-provider billing state (ST-132).
 *
 * The subscription state machine and the code that applies one verified provider event to it, shared
 * by apps/api (which processes an event when it arrives) and apps/workers (which re-processes one
 * that failed transiently). Both must reach identical conclusions about what an event means, which
 * is why this is a package and not a copy.
 *
 * Provider-agnostic in the parts that can be: the state machine, the fold, and the transition tables
 * describe Studafy's lifecycle. `event-mapping` and the event names in `state-machine` are Stripe's
 * vocabulary and are the seam a second provider would extend.
 */

export {
  attributeEvent,
  claimEvent,
  loadFoldSequence,
  markDeadLettered,
  markFailed,
  markProcessed,
  MAX_LAST_ERROR_LENGTH,
  truncateError,
} from "./billing-event-store";
export type { ClaimInput, HistoricalEvent } from "./billing-event-store";

export { resolveSchoolId, resolveTarget } from "./attribution";
export type { AttributionTarget } from "./attribution";

export {
  extractCustomerId,
  extractMetadata,
  extractPeriod,
  extractSchoolIdHint,
  extractStudentIdHint,
  extractSubscriptionId,
  extractSubscriptionItemId,
} from "./event-mapping";

export { processBillingEvent, reprocessClaimedEvent } from "./process";
export type {
  BillingAuditEntry,
  BillingAuditWriter,
  BillingLogger,
  ProcessOptions,
  ProcessOutcome,
  VerifiedBillingEvent,
} from "./process";

export {
  AI_TRANSITIONS,
  deriveIntent,
  foldStatus,
  GENESIS_STATUS,
  LIVE_STATUSES,
  resolveAiCascade,
  resolveTransition,
  SCHOOL_TRANSITIONS,
  TERMINAL_STATUSES,
} from "./state-machine";
export type {
  BillingEventIntent,
  FoldableEvent,
  FoldResult,
  IntentResolution,
  SkippedStep,
  SubscriptionKind,
} from "./state-machine";
