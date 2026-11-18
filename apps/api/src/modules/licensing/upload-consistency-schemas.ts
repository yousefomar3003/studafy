import { z } from "@hono/zod-openapi";
import { dateSchema } from "@studafy/shared-schemas";

import { aiProgrammeTierSchema } from "./ai-programme-schemas";

/**
 * OpenAPI schemas for upload consistency (phase 4 of the Student AI programme). As in
 * ai-programme-schemas.ts: every nested object has its own `.openapi("Name")`, nullable enums stay
 * inline, and no optional or nullable reference carries a description (the Dart client generator).
 */

/** Longest period one request may measure: a school year with room to spare. */
export const MAX_UPLOAD_PERIOD_DAYS = 400;

const nullableBps = z.number().int().nullable().openapi({
  description: "Basis points (10000 is 100%), rounded down; null when nothing counts.",
});

export const uploadConsistencyQuerySchema = z
  .object({
    from: dateSchema.optional().openapi({
      description: "First day measured (YYYY-MM-DD, the school's calendar). With `to`.",
    }),
    to: dateSchema.optional().openapi({
      description: "Last day measured, inclusive. With `from`. Days after today never count.",
    }),
  })
  .superRefine((value, ctx) => {
    if (!value.from && !value.to) return;
    if (!value.from || !value.to) {
      ctx.addIssue({
        code: "custom",
        path: [value.from ? "to" : "from"],
        message: "'from' and 'to' go together",
      });
      return;
    }
    const span = (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000;
    if (span < 0) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "'to' must not be before 'from'" });
    } else if (span >= MAX_UPLOAD_PERIOD_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `The period may span at most ${MAX_UPLOAD_PERIOD_DAYS} days`,
      });
    }
  });

/**
 * Where the period came from: the request, the current licence's start to date, the academic year's
 * start to date, or today alone.
 */
export const uploadPeriodBasisSchema = z
  .enum(["requested", "license", "academic_year", "today"])
  .openapi("UploadPeriodBasis");

/** `license`: the values the licence was signed with; `school`: the school's values now (no licence). */
export const uploadConsistencyBonusSourceSchema = z
  .enum(["license", "school"])
  .openapi("UploadConsistencyBonusSource");

export const uploadConsistencyClassSchema = z
  .object({
    classId: z.string().uuid(),
    code: z.string(),
    courseName: z.string(),
    sectionId: z.string().uuid().nullable(),
    schoolDays: z.number().int(),
    uploadDays: z.number().int(),
    consistencyBps: nullableBps,
    teacherIds: z.array(z.string().uuid()),
  })
  .openapi("UploadConsistencyClass");

export const uploadConsistencyTeacherSchema = z
  .object({
    teacherId: z.string().uuid(),
    userId: z.string().uuid(),
    name: z.string(),
    classIds: z.array(z.string().uuid()),
    consistencyBps: nullableBps,
  })
  .openapi("UploadConsistencyTeacher");

export const uploadConsistencyBonusSchema = z
  .object({
    licenseId: z.string().uuid().nullable(),
    source: uploadConsistencyBonusSourceSchema,
    tiers: z.array(aiProgrammeTierSchema),
    tier: aiProgrammeTierSchema.nullable(),
    nextTier: aiProgrammeTierSchema.nullable(),
    targetBps: z.number().int().nullable(),
  })
  .openapi("UploadConsistencyBonus");

export const uploadConsistencySchema = z
  .object({
    timezone: z.string(),
    today: dateSchema,
    from: dateSchema,
    to: dateSchema,
    countedTo: dateSchema.openapi({
      description: "The last day counted: `to`, or today when `to` is later.",
    }),
    basis: uploadPeriodBasisSchema,
    schoolDays: z.number().int(),
    classesCounted: z.number().int(),
    consistencyBps: nullableBps,
    classes: z.array(uploadConsistencyClassSchema),
    teachers: z.array(uploadConsistencyTeacherSchema),
    bonus: uploadConsistencyBonusSchema,
  })
  .openapi("UploadConsistency");
