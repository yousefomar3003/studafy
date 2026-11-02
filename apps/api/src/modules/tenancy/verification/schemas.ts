import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Path params — verification token
// ---------------------------------------------------------------------------

export const verifyEmailPathParams = z
  .object({
    // Format validation is performed inside the verification service, not here —
    // same pattern as invitation verification to prevent token leakage via validation logs.
    token: z.string().openapi({
      param: { name: "token", in: "path" },
      description: "Email verification token (64 lowercase hexadecimal characters).",
      example: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    }),
  })
  .openapi("VerifyEmailPathParams");

// ---------------------------------------------------------------------------
// Response — verify
// ---------------------------------------------------------------------------

export const verifyEmailResponseSchema = z
  .object({
    state: z.literal("verified"),
    school: z.object({
      id: z.string().uuid().openapi({ description: "School identifier." }),
      slug: z.string().openapi({ description: "School slug." }),
      name: z.string().openapi({ description: "School display name." }),
    }),
  })
  .openapi("VerifyEmailResponse");

// ---------------------------------------------------------------------------
// Request — resend
// ---------------------------------------------------------------------------

export const resendVerificationBodySchema = z
  .object({
    email: z
      .string()
      .email()
      .max(320)
      .openapi({
        description:
          "School contact email address. If a matching unverified school exists, " +
          "a new verification email will be sent. The response is the same regardless " +
          "of whether the email is registered.",
        example: "admin@springfield-academy.edu",
      }),
  })
  .openapi("ResendVerification");

// ---------------------------------------------------------------------------
// Response — resend
// ---------------------------------------------------------------------------

export const resendVerificationResponseSchema = z
  .object({
    message: z.string().openapi({
      description:
        "Confirmation that the request was processed. The message is the same " +
        "whether the email is registered or not, to prevent enumeration.",
      example: "If your email is registered and unverified, a verification email has been sent.",
    }),
  })
  .openapi("ResendVerificationResponse");
