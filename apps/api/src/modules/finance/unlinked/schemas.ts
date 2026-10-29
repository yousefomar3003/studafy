import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { userStatusSchema } from "../../../openapi/components";

export const unlinkedListQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional().openapi({
      description:
        "Narrows the list: a student's name or admission number, or a parent's name or email.",
    }),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("FinanceUnlinkedQuery");

export const unlinkedStudentSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    admission_number: z.string(),
    created_at: dateTimeSchema,
  })
  .openapi("FinanceUnlinkedStudent");

export const unlinkedStudentListSchema = z
  .object({ students: z.array(unlinkedStudentSchema), total: z.number().int() })
  .openapi("FinanceUnlinkedStudentList");

export const unlinkedParentSchema = z
  .object({
    user_id: uuidSchema,
    name: z.string(),
    email: z.string().nullable(),
    status: userStatusSchema,
    created_at: dateTimeSchema,
  })
  .openapi("FinanceUnlinkedParent");

export const unlinkedParentListSchema = z
  .object({ parents: z.array(unlinkedParentSchema), total: z.number().int() })
  .openapi("FinanceUnlinkedParentList");

export const unlinkedSummarySchema = z
  .object({
    students: z
      .number()
      .int()
      .openapi({ description: "Enrolled students no guardian is linked to." }),
    parents: z.number().int().openapi({ description: "PARENT accounts linked to no child." }),
  })
  .openapi("FinanceUnlinkedSummary");
