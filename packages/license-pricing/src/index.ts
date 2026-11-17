/**
 * @studafy/license-pricing -- the one place Studafy prices a school license.
 *
 * The super admin's calculator, quotes and invoices all call `calculateLicensePrice`; nothing else
 * multiplies a seat price. Pure (no database, no clock), so the console can preview a price without
 * saving and a stored quote's breakdown can be recomputed from its inputs. Money is in whole minor
 * units throughout; the rounding rules are in calculate.ts and docs/billing/feature-licensing.md.
 */

export * from "./types";
export {
  MAX_MONTHS,
  MAX_PRORATE_DAYS,
  calculateLicensePrice,
  durationDiscountFor,
  validatePriceSettings,
  volumeBracketFor,
} from "./calculate";
export { BPS_SCALE, DAYS_PER_YEAR, MONTHS_PER_YEAR, applyBps, divideHalfUp } from "./money";
export {
  MAX_CUSTOM_INSTALMENTS,
  MAX_REQUEST_MONTHS,
  MIN_REQUEST_MONTHS,
  PAYMENT_PLANS,
  SCHOOL_PAYMENT_PLANS,
  SHARE_SCALE,
  addMonthsUtc,
  allocatePayments,
  amountsFromShares,
  buildSchedule,
  customScheduleErrors,
  evenProposal,
  licenceYears,
  proposalErrors,
  scheduleMonths,
  splitByLicenceYears,
  splitEvenly,
  termsChanges,
  yearTotals,
} from "./schedule";
export type {
  AllocatedInstalment,
  CustomInstalmentInput,
  CustomScheduleError,
  InstalmentStatus,
  LicenceYear,
  LicenceYearTotal,
  OfferedTerms,
  PaymentPlan,
  ProposalError,
  ProposedInstalment,
  RequestedTerms,
  ScheduleInput,
  ScheduledInstalment,
  SchoolPaymentPlan,
  TermsChange,
} from "./schedule";
export {
  AI_PROGRAMME_FIELDS,
  AI_PROGRAMME_LIMITS,
  AI_PROGRAMME_OVERRIDE_FIELDS,
  AI_PROGRAMME_PAYOUT_MODES,
  AI_PROGRAMME_TIER_KINDS,
  DEFAULT_AI_PROGRAMME_SETTINGS,
  EMPTY_AI_PROGRAMME_OVERRIDE,
  aiProgrammeChanges,
  isEmptyAiProgrammeOverride,
  nextTierFor,
  previewRevenueShare,
  resolveAiProgramme,
  schoolMarginOf,
  tierFor,
  validateAiProgrammeOverride,
  validateAiProgrammeSettings,
} from "./ai-programme";
export type {
  AiProgrammeField,
  AiProgrammeIssue,
  AiProgrammeIssueCode,
  AiProgrammeMargin,
  AiProgrammeOverride,
  AiProgrammeOverrideField,
  AiProgrammePayoutMode,
  AiProgrammePrice,
  AiProgrammeSettings,
  AiProgrammeTier,
  AiProgrammeTierKind,
  ResolvedAiProgramme,
  RevenueSharePreview,
  RevenueSharePreviewInput,
} from "./ai-programme";
export {
  academicYearMonths,
  monthCount,
  monthEnd,
  monthIndex,
  monthKey,
  monthStart,
} from "./academic-months";
export type { MonthIndex, MonthRange } from "./academic-months";
export {
  AI_OPTIN_SOURCES,
  AI_OPTIN_STATUSES,
  AI_OPTIN_TERMS_VERSION,
  LICENSE_COMMITMENTS,
  aiOptInPeriod,
  aiOptInTotal,
  firstOfMonth,
  firstOfNextMonth,
  monthsBetween,
} from "./ai-optin";
export type { AiOptInPeriod, AiOptInSource, AiOptInStatus, LicenseCommitment } from "./ai-optin";
export {
  computeUploadConsistency,
  contentBonusStanding,
  daysInRange,
  nextDay,
  schoolDaysBetween,
} from "./upload-consistency";
export type {
  ContentBonusStanding,
  DayRange,
  UploadConsistencyClassInput,
  UploadConsistencyClassResult,
  UploadConsistencyInput,
  UploadConsistencyResult,
  UploadConsistencyTeacherResult,
} from "./upload-consistency";
export {
  addDaysUtc,
  computeRevenueShare,
  instalmentPeriods,
  measurementDateOf,
  ratioBps,
  shareAmountOf,
  studentPartOf,
} from "./revenue-share";
export type {
  InstalmentPeriod,
  InstalmentPeriodInput,
  RevenueShareInput,
  RevenueShareResult,
  RevenueShareSettings,
} from "./revenue-share";
export {
  contentBonusAimBps,
  conversionStanding,
  optInsToReach,
  paidPartOf,
  studafyNetOf,
  studentAiMarginOf,
} from "./ai-dashboard";
export type {
  ConversionStanding,
  ConversionStandingInput,
  ConversionTierSettings,
  StudafyNet,
} from "./ai-dashboard";
