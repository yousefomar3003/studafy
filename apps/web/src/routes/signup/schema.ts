import { z } from "zod";

/**
 * Client-side mirror of `submitApplicationBodySchema`
 * (apps/api/src/modules/school-applications/schemas.ts), so the form rejects bad input inline.
 * Messages are translation keys (`onboarding.validation.*` / `onboarding.signup.validation.*`),
 * translated where they are rendered -- see `fieldErrors` in ../onboarding/schema.ts.
 */

const REQUIRED = "onboarding.signup.validation.required";
const TOO_LONG = "onboarding.validation.tooLong";

const requiredText = (max: number) => z.string().trim().min(1, REQUIRED).max(max, TOO_LONG);
const optionalText = (max: number) => z.string().trim().max(max, TOO_LONG);

export const PROOF_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const PROOF_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export const applicationFormSchema = z.object({
  applicant_name: requiredText(200),
  applicant_job_title: optionalText(120),
  applicant_phone: z
    .string()
    .trim()
    .min(5, "onboarding.signup.validation.phone")
    .max(50, TOO_LONG)
    .regex(/^[+\d][\d\s()-]*$/, "onboarding.signup.validation.phone"),
  school_name: requiredText(200),
  school_email: z
    .string()
    .trim()
    .max(320, TOO_LONG)
    .refine(
      (value) => value === "" || z.email().safeParse(value).success,
      "onboarding.validation.emailInvalid",
    ),
  country_id: z.string().min(1, "onboarding.validation.countryRequired"),
  default_currency_id: z.string().min(1, "onboarding.validation.currencyRequired"),
  city: requiredText(120),
  address: requiredText(500),
  website: optionalText(300),
  student_count: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || (/^\d+$/.test(value) && Number(value) <= 1_000_000),
      "onboarding.signup.validation.studentCount",
    ),
  message: optionalText(5000),
});

export type ApplicationForm = z.infer<typeof applicationFormSchema>;

export const EMPTY_APPLICATION_FORM: ApplicationForm = {
  applicant_name: "",
  applicant_job_title: "",
  applicant_phone: "",
  school_name: "",
  school_email: "",
  country_id: "",
  default_currency_id: "",
  city: "",
  address: "",
  website: "",
  student_count: "",
  message: "",
};

/** A translation key describing why `file` cannot be the proof of ownership, or null if it can. */
export function proofFileError(file: File | null): string | null {
  if (!file) return "onboarding.signup.validation.proofRequired";
  if (!(PROOF_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return "onboarding.signup.validation.proofType";
  }
  if (file.size === 0 || file.size > PROOF_MAX_SIZE_BYTES) {
    return "onboarding.signup.validation.proofSize";
  }
  return null;
}
