import { z } from "@hono/zod-openapi";

/**
 * Contracts for the public "Talk to us" form (`POST /api/inquiries`). snake_case, like the other
 * pre-signup public bodies (`/api/schools/register`, `/api/account/deletion-requests`). The
 * platform console's view of the same rows is camelCase and lives in modules/platform/schemas.ts.
 */

export const INQUIRY_STATUSES = ["new", "contacted", "won", "lost"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

export const submitInquiryBodySchema = z
  .object({
    full_name: z.string().trim().min(1).max(200).openapi({ example: "Sara Al-Ahmad" }),
    email: z.string().trim().email().max(320).openapi({ example: "sara@school.example" }),
    phone: optionalText(50),
    school_name: z.string().trim().min(1).max(200).openapi({ example: "Al Noor International" }),
    job_title: optionalText(120),
    country: optionalText(120),
    student_count: z.number().int().min(0).max(1_000_000).optional(),
    message: optionalText(5000),
    /** The marketing page the visitor submitted from, e.g. `/pricing`. */
    source_path: optionalText(300),
    captcha_token: z.string().min(1).openapi({ description: "Cloudflare Turnstile token." }),
  })
  .openapi("SubmitInquiry");

export const submitInquiryResponseSchema = z
  .object({ message: z.string() })
  .openapi("SubmitInquiryResponse");
