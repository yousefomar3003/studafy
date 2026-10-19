import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/** The lifecycle states of app.school_status a client can observe on its own school. */
const schoolStatusSchema = z
  .enum(["registered", "pending", "active", "suspended", "archived"])
  .openapi({ description: "The school's lifecycle status. `archived` means closed." });

export const currentSchoolResponseSchema = z
  .object({
    id: uuidSchema,
    name: z.string().openapi({ example: "Al Noor International School" }),
    status: schoolStatusSchema,
  })
  .openapi("CurrentSchool");

export const schoolClosureBodySchema = z
  .object({
    confirm_school_name: z
      .string()
      .min(1)
      .max(200)
      .openapi({
        description:
          "The school's name, typed by the administrator to confirm. Compared trimmed and " +
          "case-insensitively; a mismatch is rejected with SCHOOL_CLOSURE_NAME_MISMATCH.",
        example: "Al Noor International School",
      }),
    // Nullable as well as optional: generated clients serialize an unset field as `null`.
    reason: z.string().trim().max(1000).nullish().openapi({
      description: "Optional free-text reason, recorded in the audit log.",
    }),
  })
  .openapi("SchoolClosureRequest");

export const schoolClosureResponseSchema = z
  .object({
    school_id: uuidSchema,
    status: z.literal("archived"),
    closed_at: dateTimeSchema,
  })
  .openapi("SchoolClosure");
