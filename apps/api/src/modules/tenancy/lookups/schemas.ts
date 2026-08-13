import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Response — countries
// ---------------------------------------------------------------------------

export const countriesResponseSchema = z
  .object({
    countries: z.array(
      z.object({
        id: z.string().uuid().openapi({ description: "Country identifier (app.countries.id)." }),
        alpha2_code: z.string().openapi({ description: "ISO 3166-1 alpha-2 code.", example: "US" }),
        name: z.string().openapi({ description: "Country name.", example: "United States" }),
      }),
    ),
  })
  .openapi("CountriesResponse");

// ---------------------------------------------------------------------------
// Response — currencies
// ---------------------------------------------------------------------------

export const currenciesResponseSchema = z
  .object({
    currencies: z.array(
      z.object({
        id: z.string().uuid().openapi({ description: "Currency identifier (app.currencies.id)." }),
        code: z.string().openapi({ description: "ISO 4217 currency code.", example: "USD" }),
        name: z.string().openapi({ description: "Currency name.", example: "US Dollar" }),
      }),
    ),
  })
  .openapi("CurrenciesResponse");
