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
 * vocabulary. A second provider (Tap) normalizes its events *into* that vocabulary at the adapter,
 * so the state machine has one dialect to read; only the ledger key and the customer-id column are
 * provider-aware.
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
export type {
  BillingEventSource,
  BillingProvider,
  ClaimInput,
  HistoricalEvent,
} from "./billing-event-store";

export { addBillingInterval, isBillingInterval } from "./billing-period";
export type { BillingInterval } from "./billing-period";

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

export { processBillingEvent, reprocessClaimedEvent, GRACE_PERIOD_DAYS } from "./process";
export type {
  BillingAuditEntry,
  BillingAuditWriter,
  BillingLogger,
  EntitlementChange,
  EntitlementChangePublisher,
  ProcessOptions,
  ProcessOutcome,
  VerifiedBillingEvent,
} from "./process";

export { applySystemTransition } from "./system-transition";
export type { SystemTransitionInput, SystemTransitionOutcome } from "./system-transition";

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

export {
  loadSiblingDiscountRule,
  loadSiblingStandings,
  siblingPercentageFor,
  tierPercentageFor,
} from "./sibling-discount";
export type { SiblingDiscountRule, SiblingDiscountTier, SiblingStanding } from "./sibling-discount";

export { isLiveStripeMode, stripeModeFromKey } from "./stripe-mode";
export type { StripeMode } from "./stripe-mode";

// The Student AI revenue share engine (000237): shared by the API (payments, the console) and the
// workers (the hourly lock-and-settle pass), so both work a share out the same way.
export {
  LOCK_CATCH_UP_DAYS,
  REVENUE_SHARE_STATUSES,
  approveShares,
  insertSnapshot,
  licenceInProgramme,
  lockDueConversionSnapshots,
  measureConversion,
  measurementDayOf,
  measurementPeriods,
  periodFor,
  recordEarlierPaymentShares,
  recordPaymentShares,
  rejectShares,
  resolvePendingShares,
  restoreCreditsOfVoidedInvoice,
  runRevenueShareTick,
  settleRevenueShare,
  utcDay,
  voidPaymentShares,
} from "./ai-revenue-share/engine";
export type {
  ConversionMeasurement,
  DecidedShare,
  PaymentPortion,
  RecordedShare,
  ResolvedShare,
  RevenueShareAudit,
  RevenueShareAuditEntry,
  RevenueShareContext,
  RevenueShareStatus,
  RevenueShareTick,
  SettleChange,
  SnapshotRecord,
  VoidedShare,
} from "./ai-revenue-share/engine";
export {
  REVENUE_SHARE_MEASURES,
  countEnrolledStudents,
  countStudentAiHolders,
  licenceCommitment,
  uploadConsistencyForPeriod,
} from "./ai-revenue-share/measures";
export type { ConsistencyPeriod, RevenueShareMeasures } from "./ai-revenue-share/measures";
export { readProgrammeValues } from "./ai-revenue-share/programme";
export {
  activateLicence,
  isRetryableTransactionError,
  licencesToPutInForce,
  personalSubscriptionsOnLicence,
  withTransactionRetry,
} from "./ai-revenue-share/activation";
export type { LicencesToPutInForce } from "./ai-revenue-share/activation";
export {
  schoolCalendar,
  studentAiClassIds,
  uploadConsistency,
} from "./ai-revenue-share/upload-consistency";
export type {
  SchoolCalendar,
  UploadConsistencyClassView,
  UploadConsistencyReport,
  UploadConsistencyTeacherView,
  UploadPeriod,
} from "./ai-revenue-share/upload-consistency";
export type { ProgrammeStamp } from "./ai-revenue-share/programme";
