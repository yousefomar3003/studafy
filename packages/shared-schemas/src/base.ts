import { z } from "zod";

/**
 * Base Zod primitives shared by API routes and web forms. Naming convention: every schema is
 * `<name>Schema`, and its inferred TypeScript type is exported alongside it via `z.infer`.
 * See docs/schema-conventions.md.
 */

/** RFC 4122 UUID string. */
export const uuidSchema = z.uuid();
export type Uuid = z.infer<typeof uuidSchema>;

/**
 * Money as integer minor units (e.g. cents) plus an ISO-4217 alpha-3 currency code. Integer
 * minor units avoid floating-point rounding; the canonical representation is documented in
 * docs/schema-conventions.md.
 */
export const moneySchema = z.object({
  amountMinor: z.int(),
  currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO-4217 alpha-3 currency code"),
});
export type Money = z.infer<typeof moneySchema>;

/** Calendar date, ISO-8601 `YYYY-MM-DD`. */
export const dateSchema = z.iso.date();
export type DateString = z.infer<typeof dateSchema>;

/** Timestamp, ISO-8601 date-time (UTC). */
export const dateTimeSchema = z.iso.datetime();
export type DateTimeString = z.infer<typeof dateTimeSchema>;
