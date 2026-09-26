/**
 * Which payment provider bills a school (ST-298).
 *
 * Decided by the school's country (`app.schools.country_id` -> `app.countries.alpha2_code`), the one
 * region fact the schema already holds. Schools in Tap's MENA markets go through Tap, where mada,
 * KNET and Benefit are available; everyone else goes through Stripe. The same answer applies to
 * subscription checkout and to online fee collection, so both ask this module rather than each
 * keeping its own country list.
 *
 * There is deliberately no fallback. A Jordanian school whose deployment has no Tap key gets a 503,
 * not a Stripe checkout: silently switching provider would put the school's customer, its
 * payments and its webhooks at a provider nobody configured for it, and hide the misconfiguration.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { PaymentProviderPort } from "./ports/payment-provider";
import type { BillingProvider } from "@studafy/billing";
import type { ErrorCode } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * ISO 3166-1 alpha-2 codes of the countries routed to Tap: the markets Tap acquires in. Confirm
 * against the Tap merchant account before adding a country -- see docs/runbooks/tap-payments-setup.md.
 */
export const TAP_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AE",
  "BH",
  "EG",
  "JO",
  "KW",
  "OM",
  "QA",
  "SA",
]);

/** The configured adapters, one slot per provider. `null` when that provider has no credentials. */
export type PaymentProviderRegistry = Readonly<Record<BillingProvider, PaymentProviderPort | null>>;

export interface SelectedPaymentProvider {
  name: BillingProvider;
  port: PaymentProviderPort;
}

const NOT_CONFIGURED: Readonly<Record<BillingProvider, { code: ErrorCode; label: string }>> = {
  stripe: { code: ERROR_CODES.STRIPE_NOT_CONFIGURED, label: "Stripe" },
  tap: { code: ERROR_CODES.TAP_NOT_CONFIGURED, label: "Tap Payments" },
};

export function resolveProviderForCountry(countryAlpha2: string): BillingProvider {
  return TAP_COUNTRY_CODES.has(countryAlpha2.toUpperCase()) ? "tap" : "stripe";
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
  return requirePaymentProvider(registry, resolveProviderForCountry(countryAlpha2));
}

/**
 * The provider for one school, read inside the caller's transaction.
 *
 * `app.schools` and `app.countries` are both global tables, so this needs no tenant predicate beyond
 * the school id itself.
 */
export async function selectPaymentProviderForSchool(
  tx: TransactionSql,
  registry: PaymentProviderRegistry,
  schoolId: string,
): Promise<SelectedPaymentProvider> {
  const [row] = await tx<{ alpha2_code: string }[]>`
    SELECT c.alpha2_code
    FROM app.schools s
    JOIN app.countries c ON c.id = s.country_id
    WHERE s.id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
  }

  return selectPaymentProvider(registry, row.alpha2_code);
}
