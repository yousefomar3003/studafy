/**
 * Which payment provider bills a school (ST-298).
 *
 * Decided by the school's country (`app.schools.country_id` -> `app.countries.alpha2_code`), the one
 * region fact the schema already holds. Schools in the deployment's Tap countries (`TAP_COUNTRIES`)
 * go through Tap, where mada, KNET and Benefit are available; everyone else goes through Stripe. The
 * same answer applies to subscription checkout and to online fee collection, so both ask this module
 * rather than each keeping its own country list.
 *
 * Tap only signs up merchants registered in its own markets, so which countries use it depends on
 * where the operating company is registered: none by default (Studafy's company is Irish, so every
 * school bills through Stripe), and a deployment run by a company Tap accepts lists them.
 *
 * There is deliberately no fallback. A school in a Tap country whose deployment has no Tap key gets a
 * 503, not a Stripe checkout: silently switching provider would put the school's customer, its
 * payments and its webhooks at a provider nobody configured for it, and hide the misconfiguration.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { PaymentProviderPort } from "./ports/payment-provider";
import type { BillingProvider } from "@studafy/billing";
import type { ErrorCode } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * ISO 3166-1 alpha-2 codes of the markets Tap acquires in: the only countries `TAP_COUNTRIES` may
 * list. Confirm against the Tap merchant account before adding one -- see
 * docs/runbooks/tap-payments-setup.md.
 */
export const TAP_MARKETS: ReadonlySet<string> = new Set([
  "AE",
  "BH",
  "EG",
  "JO",
  "KW",
  "OM",
  "QA",
  "SA",
]);

/** The configured adapters, one slot per provider (`null` when it has no credentials). */
export interface PaymentProviderRegistry {
  readonly stripe: PaymentProviderPort | null;
  readonly tap: PaymentProviderPort | null;
  /** Countries billed through Tap (a subset of {@link TAP_MARKETS}); absent or empty: none. */
  readonly tapCountries?: ReadonlySet<string>;
}

export interface SelectedPaymentProvider {
  name: BillingProvider;
  port: PaymentProviderPort;
}

const NOT_CONFIGURED: Readonly<Record<BillingProvider, { code: ErrorCode; label: string }>> = {
  stripe: { code: ERROR_CODES.STRIPE_NOT_CONFIGURED, label: "Stripe" },
  tap: { code: ERROR_CODES.TAP_NOT_CONFIGURED, label: "Tap Payments" },
};

export function resolveProviderForCountry(
  countryAlpha2: string,
  tapCountries: ReadonlySet<string> = new Set(),
): BillingProvider {
  return tapCountries.has(countryAlpha2.toUpperCase()) ? "tap" : "stripe";
}

/** The named provider's adapter, or a 503 naming the provider that is missing. */
export function requirePaymentProvider(
  registry: PaymentProviderRegistry,
  name: BillingProvider,
): SelectedPaymentProvider {
  const port = registry[name];
  if (!port) {
    const { code, label } = NOT_CONFIGURED[name];
    throw new CodedHttpException(
      503,
      code,
      `${label} billing is not configured for this deployment`,
    );
  }
  return { name, port };
}

export function selectPaymentProvider(
  registry: PaymentProviderRegistry,
  countryAlpha2: string,
): SelectedPaymentProvider {
  return requirePaymentProvider(
    registry,
    resolveProviderForCountry(countryAlpha2, registry.tapCountries),
  );
}

/**
 * The provider for one school, read inside the caller's transaction.
 *
 * `app.schools` and `app.countries` are both global tables, so this needs no tenant predicate beyond
 * the school id itself.
 *
 * Every school-scoped checkout (subscription and online fee payment) passes through here, so this is
 * where the reviewer demo tenant (ST-303) is refused before any provider is called. Migration 000116
 * backs it with a CHECK that the tenant can never hold a provider customer id.
 */
export async function selectPaymentProviderForSchool(
  tx: TransactionSql,
  registry: PaymentProviderRegistry,
  schoolId: string,
): Promise<SelectedPaymentProvider> {
  const [row] = await tx<{ alpha2_code: string; is_review_tenant: boolean }[]>`
    SELECT c.alpha2_code, s.is_review_tenant
    FROM app.schools s
    JOIN app.countries c ON c.id = s.country_id
    WHERE s.id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
  }

  if (row.is_review_tenant) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.REVIEW_TENANT_BILLING_DISABLED,
      "Billing is disabled for the demo school",
    );
  }

  return selectPaymentProvider(registry, row.alpha2_code);
}
