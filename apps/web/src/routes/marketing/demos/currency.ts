/**
 * The currencies the pricing card can show its (zero) cost in, which one a visitor sees first, and
 * remembering the one they pick. Kept apart from the component so the default rule is a plain,
 * tested function.
 */

/** In the order the switcher shows them. */
export const PRICING_CURRENCIES = ["USD", "GBP", "EUR", "SAR", "JOD"] as const;

export type PricingCurrency = (typeof PRICING_CURRENCIES)[number];

const FALLBACK_CURRENCY: PricingCurrency = "USD";

/**
 * The 21 euro-area members (Bulgaria joined on 1 January 2026), plus Andorra, Monaco, San Marino
 * and the Vatican, which use the euro by formal agreement.
 */
const EURO_REGIONS = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "DE",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PT",
  "SI",
  "SK",
  "AD",
  "MC",
  "SM",
  "VA",
]);

const REGION_CURRENCY: ReadonlyMap<string, PricingCurrency> = new Map([
  ["GB", "GBP"],
  ["JO", "JOD"],
  ["SA", "SAR"],
]);

function regionOf(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag).region;
  } catch {
    // Not a valid BCP 47 tag: it says nothing about where the visitor is.
    return undefined;
  }
}

/**
 * The currency to show first, from the browser's locale tags (`navigator.languages`, most preferred
 * first). The first tag that names a region decides: Jordan → JOD, Saudi Arabia → SAR, the UK →
 * GBP, a country that uses the euro → EUR. Anything else, or no region at all (a bare `ar` or
 * `en` says nothing about the country), is USD.
 */
export function defaultPricingCurrency(localeTags: readonly string[]): PricingCurrency {
  for (const tag of localeTags) {
    const region = regionOf(tag);
    if (!region) continue;
    if (EURO_REGIONS.has(region)) return "EUR";
    return REGION_CURRENCY.get(region) ?? FALLBACK_CURRENCY;
  }
  return FALLBACK_CURRENCY;
}

export function isPricingCurrency(value: unknown): value is PricingCurrency {
  return (PRICING_CURRENCIES as readonly unknown[]).includes(value);
}

/** Versioned like the app's other stored preferences, so a later shape change can ignore old values. */
export const PRICING_CURRENCY_STORAGE_KEY = "studafy.pricing.currency.v1";

/** The visitor's earlier pick, if storage works and holds one we still offer. */
export function loadPricingCurrency(): PricingCurrency | undefined {
  try {
    const stored = window.localStorage.getItem(PRICING_CURRENCY_STORAGE_KEY);
    return isPricingCurrency(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function savePricingCurrency(currency: PricingCurrency): void {
  try {
    window.localStorage.setItem(PRICING_CURRENCY_STORAGE_KEY, currency);
  } catch {
    // Storage unavailable (private browsing, blocked site data): the pick lasts for this visit only.
  }
}

/** The browser's locale tags, most preferred first; empty outside a browser. */
export function browserLocaleTags(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}
