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
