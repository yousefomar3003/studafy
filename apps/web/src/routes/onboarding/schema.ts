import { z } from "zod";

/**
 * Client-side mirror of the API's request schema
 * (apps/api/src/modules/tenancy/registration/schemas.ts `registerSchoolBodySchema`), split across
 * the two wizard steps so each step can validate only its own fields. Kept in step with the
 * backend deliberately — this is what lets "Next"/"Submit" reject bad input inline instead of
 * round-tripping to the server for every mistake.
 */

// Mirrors apps/api/src/modules/tenancy/registration/schemas.ts exactly. The hyphen delimiter
// between repeated groups rules out the overlapping-match ambiguity that causes catastrophic
// backtracking, so this is a documented false positive rather than a rewrite-worthy pattern.
// eslint-disable-next-line security/detect-unsafe-regex
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Validation messages are translation keys (`onboarding.validation.*`), not display text — the
// schema is built at module load, before any locale is known, so the step that renders the error
// translates it with `t()` at render time instead.
const INVALID_EMAIL = "onboarding.validation.emailInvalid";
const TOO_LONG = "onboarding.validation.tooLong";
const INVALID_VALUE = "onboarding.validation.invalid";

export const schoolDetailsSchema = z.object({
  school_name: z
    .string()
    .trim()
    .min(1, "onboarding.validation.schoolNameRequired")
    .max(200, TOO_LONG),
  slug: z
    .string()
    .trim()
    .min(3, "onboarding.validation.slugTooShort")
    .max(63, TOO_LONG)
    .regex(SLUG_PATTERN, "onboarding.validation.slugPattern"),
  email: z.email(INVALID_EMAIL).max(320, TOO_LONG),
  // Values are always populated from the /api/lookups/* response (real UUIDs), never typed by
  // hand — so the only thing worth validating client-side is "something was selected". The
  // backend re-validates the UUID itself regardless.
  country_id: z.string().min(1, "onboarding.validation.countryRequired"),
  default_currency_id: z.string().min(1, "onboarding.validation.currencyRequired"),
});

export type SchoolDetails = z.infer<typeof schoolDetailsSchema>;

export const adminContactSchema = z.object({
  admin_email: z.email(INVALID_EMAIL).max(320, TOO_LONG),
  admin_name: z.union([z.string().trim().min(1).max(200, TOO_LONG), z.literal("")]).optional(),
});

export type AdminContact = z.infer<typeof adminContactSchema>;

/** Lowercase, hyphenated slug suggestion from a school name — still user-editable. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * First validation message per top-level field, for rendering against `Input`/`Select` `error`
 * props. Values are translation keys — pass each through `t()` where it is displayed. An issue
 * without a schema-supplied key (a Zod default message) falls back to a generic "invalid" key so
 * raw English never reaches a translated screen.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in errors)) {
      // eslint-disable-next-line security/detect-object-injection -- `field` comes from this module's own Zod schema issues, and `errors` is a fresh local object, not a shared/prototype-bearing one
      errors[field] = issue.message.startsWith("onboarding.") ? issue.message : INVALID_VALUE;
    }
  }
  return errors;
}
