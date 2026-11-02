import type { Database } from "../../../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CountryRow {
  id: string;
  alpha2_code: string;
  name: string;
}

export interface CurrencyRow {
  id: string;
  code: string;
  name: string;
}

// ---------------------------------------------------------------------------
// GET /api/lookups/countries
// ---------------------------------------------------------------------------

/**
 * List active countries, for populating the school-registration country selector.
 * `app.countries` is a small (248-row) global reference table, so this is a plain
 * unpaginated read — no tenant context, no transaction.
 */
export async function listCountries(database: Database): Promise<CountryRow[]> {
  return database<CountryRow[]>`
    SELECT id::text, alpha2_code, name
    FROM app.countries
    WHERE is_active = true
    ORDER BY name
  `;
}

// ---------------------------------------------------------------------------
// GET /api/lookups/currencies
// ---------------------------------------------------------------------------

/**
 * List active currencies, for populating the school-registration default-currency selector.
 * `app.currencies` is a small (157-row) global reference table, so this is a plain
 * unpaginated read — no tenant context, no transaction.
 */
export async function listCurrencies(database: Database): Promise<CurrencyRow[]> {
  return database<CurrencyRow[]>`
    SELECT id::text, code, name
    FROM app.currencies
    WHERE is_active = true
    ORDER BY name
  `;
}
