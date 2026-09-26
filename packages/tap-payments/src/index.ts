/**
 * Tap Payments (ST-298): the HTTP client, money formatting and webhook signature shared by
 * apps/api and apps/workers. Studafy-specific behaviour -- the port adapter, event normalization,
 * renewal scheduling -- lives with its callers, not here.
 */

export type {
  CreateHostedChargeInput,
  CreateSavedCardChargeInput,
  ListChargesInput,
  ListChargesResult,
  TapCharge,
} from "./charge";
export { tapChargeOutcome } from "./charge-status";
export type { TapChargeOutcome } from "./charge-status";
export { TAP_API_BASE_URL, TapApiError, TapClient } from "./client";
export type { TapClientOptions } from "./client";
export {
  fromTapAmount,
  TAP_CURRENCY_EXPONENTS,
  TapAmountError,
  tapCurrencyExponent,
  toTapAmount,
} from "./currency";
export { buildTapHashInput, computeTapHashString, verifyTapHashString } from "./signature";
