/**
 * School feature licenses and seats (docs/billing/feature-licensing.md, session 2): the super
 * admin's license console (/api/platform/schools/{schoolId}/licenses...), the school's own seat
 * management (/api/school/license...), and the overlap with personal subscriptions; and, since
 * session 3, pricing, quotes, invoices and bank-transfer payments.
 */

export { platformLicenseRoutes } from "./platform-routes";
export { schoolLicenseRoutes } from "./school-routes";
export { platformLicenseBillingRoutes } from "./billing-platform-routes";
export { schoolLicenseBillingRoutes } from "./billing-school-routes";
export { platformLicenseConsoleRoutes } from "./console-routes";
export { platformAiProgrammeRoutes } from "./ai-programme-routes";
export {
  INITIAL_AI_PROGRAMME_VERSION_ID,
  attachAiProgramme,
  clearSchoolOverride,
  currentAiProgrammeStamp,
  currentAiProgrammeVersion,
  licenseAiProgramme,
  reapplyAiProgramme,
  resolveAiProgrammeStamp,
  saveAiProgrammeVersion,
  saveSchoolOverride,
  schoolAiProgramme,
  type AiProgrammeStamp,
} from "./ai-programme";
export {
  activateEarly,
  createReceipt,
  financeTotals,
  issueInvoice,
  matchReceipt,
  readInvoice,
  recordPayment,
  setInvoicePaymentLink,
  voidInvoice,
  voidPayment,
  writeBankDetails,
  type InvoiceRecord,
} from "./invoices";
export { addMonths, priceQuote, replacePriceSettings, type QuoteTerms } from "./pricing";
export {
  acceptQuote,
  createQuote,
  declineQuote,
  readQuote,
  sendQuote,
  withdrawQuote,
} from "./quotes";
export {
  LICENSE_TRANSITIONS,
  assignSeats,
  createChangeRequest,
  createLicense,
  currentLicense,
  extendLicense,
  listEligible,
  listSeats,
  purchasedSeats,
  readLicense,
  runLicenseChange,
  transitionLicense,
  unassignSeat,
  updateLicense,
  type Audience,
  type LicenseRecord,
  type LicenseStatus,
  type LicensingDeps,
  type SeatScope,
} from "./service";
export {
  applyRenewalStops,
  computeOverlapCredit,
  recordSeatOverlaps,
  renewalActionFor,
  type RenewalProviders,
} from "./overlap";
export { inSchool, type LicenseActor } from "./context";
// Student AI content bonus (phase 4): upload consistency per class, teacher and school.
export { uploadConsistencyRoutes } from "./upload-consistency-routes";
export {
  contentBonusTiersFor,
  currentUploadPeriod,
  studentAiClassIds,
  uploadConsistency,
  uploadConsistencyBonus,
  uploadConsistencyView,
  type UploadConsistencyBonusView,
  type UploadConsistencyClassView,
  type UploadConsistencyReport,
  type UploadConsistencyTeacherView,
  type UploadConsistencyView,
  type UploadPeriod,
} from "./upload-consistency";
