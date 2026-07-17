import { z } from "../openapi/registry";

// ---------------------------------------------------------------------------
// Student domain schemas — demonstrates the canonical pattern for OpenAPI-
// documented routes. Every schema is a plain Zod object; the `createOpenApiRoute`
// wrapper in registry.ts handles error envelope injection automatically.
// ---------------------------------------------------------------------------

/** A student entity returned by the API. */
export const studentSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Unique student identifier." }),
    firstName: z.string().openapi({ description: "Given name." }),
    lastName: z.string().openapi({ description: "Family name." }),
    email: z.string().email().openapi({ description: "School email address." }),
    gradeLevel: z.number().int().min(1).max(12).openapi({ description: "Grade level (1-12)." }),
    createdAt: z.string().datetime().openapi({ description: "ISO-8601 creation timestamp." }),
  })
  .openapi("Student");

export type Student = z.infer<typeof studentSchema>;

/** Request body for creating a new student. */
export const createStudentBodySchema = z
  .object({
    firstName: z.string().min(1).max(100).openapi({ description: "Given name." }),
    lastName: z.string().min(1).max(100).openapi({ description: "Family name." }),
    email: z.string().email().openapi({ description: "School email address." }),
    gradeLevel: z.number().int().min(1).max(12).openapi({ description: "Grade level (1-12)." }),
  })
  .openapi("CreateStudentBody");

export type CreateStudentBody = z.infer<typeof createStudentBodySchema>;

/** Query parameters for listing students. */
export const listStudentsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .openapi({ description: "Maximum number of results (1-100).", example: 20 }),
    cursor: z
      .string()
      .optional()
      .openapi({ description: "Opaque pagination cursor from a previous response." }),
    gradeLevel: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .openapi({ description: "Filter by grade level." }),
  })
  .openapi("ListStudentsQuery");

export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;

/** Paginated list of students. */
export const studentListResponseSchema = z
  .object({
    data: z.array(studentSchema).openapi({ description: "Array of student entities." }),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: "Pagination cursor for the next page. Null if no more pages." }),
  })
  .openapi("StudentListResponse");
