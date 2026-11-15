import { z } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const registerSchoolBodySchema = z
  .object({
    school_name: z.string().min(1).max(200).openapi({
      description: "Display name of the school.",
      example: "Springfield Academy",
    }),
    slug: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens.")
      .openapi({
        description:
          "URL-safe school identifier. 3-63 characters, lowercase alphanumeric with hyphens.",
        example: "springfield-academy",
      }),
    email: z.string().email().max(320).openapi({
      description: "School contact email address. Must be unique across the platform.",
      example: "admin@springfield-academy.edu",
    }),
    country_id: z.string().uuid().openapi({
      description: "UUID of the country from app.countries.",
      example: "d07d5b8e-1c2a-4f3e-9b6a-8c1d2e3f4a5b",
    }),
    default_currency_id: z.string().uuid().openapi({
      description: "UUID of the default currency from app.currencies.",
      example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }),
    admin_email: z.string().email().max(320).openapi({
      description:
        "Email address of the first administrator. An invitation will be sent to this address.",
      example: "principal@springfield-academy.edu",
    }),
    admin_name: z.string().min(1).max(200).optional().openapi({
      description: "Display name for the first administrator.",
      example: "Dr. Jane Smith",
    }),
    captcha_token: z.string().min(1).openapi({
      description: "Cloudflare Turnstile captcha token from the client widget.",
    }),
  })
  .openapi("RegisterSchool");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const registerSchoolResponseSchema = z
  .object({
    school: z.object({
      id: z.string().uuid().openapi({ description: "School identifier." }),
      slug: z.string().openapi({ description: "School slug." }),
      name: z.string().openapi({ description: "School display name." }),
      status: z.literal("registered").openapi({ description: "School status." }),
      created_at: z
        .string()
        .datetime()
        .openapi({ description: "Registration timestamp (ISO 8601)." }),
    }),
    admin: z.object({
      id: z.string().uuid().openapi({ description: "Administrator user identifier." }),
      email: z.string().email().openapi({ description: "Administrator email address." }),
      role: z
        .literal(ROLES.ORG_ADMIN)
        .openapi({ description: "Role assigned to the administrator." }),
    }),
    invitation: z.object({
      expires_at: z
        .string()
        .datetime()
        .openapi({
          description:
            "Expiry of the activation invitation emailed to the administrator (ISO 8601). The token " +
            "itself is never returned by this endpoint.",
        }),
    }),
    verification: z.object({
      expires_at: z
        .string()
        .datetime()
        .openapi({
          description:
            "Expiry of the verification link emailed to the school contact address — 24 hours from " +
            "registration (ISO 8601). The token itself is never returned by this endpoint.",
        }),
    }),
  })
  .openapi("RegisterSchoolResponse");
