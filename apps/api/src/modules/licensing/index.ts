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
export {
  activateEarly,
  createReceipt,
  financeTotals,
  issueInvoice,
  matchReceipt,
  readInvoice,
  recordPayment,
  voidInvoice,
  voidPayment,
  writeBankDetails,
  type InvoiceRecord,
} from "./invoices";
export { addMonths, priceQuote, replacePriceSettings, type QuoteTerms } from "./pricing";
export { acceptQuote, createQuote, readQuote, sendQuote, withdrawQuote } from "./quotes";
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
