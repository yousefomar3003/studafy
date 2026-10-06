import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { sanitizedTextSchema } from "../../lib/sanitize";

export const schoolEventKindSchema = z
  .enum(["holiday", "event", "meeting", "exam_period"])
  .openapi({
    description: "What kind of calendar entry this is; drives how the calendar shows it.",
  });

/** Longest window a single list call may span, so one request can't scan the school's whole history. */
export const MAX_RANGE_DAYS = 400;

export const schoolEventSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    created_by: uuidSchema,
    title: z.string(),
    description: z.string().nullable(),
    kind: schoolEventKindSchema,
    starts_on: dateSchema.openapi({ description: "First day, inclusive (YYYY-MM-DD)." }),
    ends_on: dateSchema.openapi({ description: "Last day, inclusive (YYYY-MM-DD)." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("SchoolEvent");

export const schoolEventListSchema = z
  .object({ items: z.array(schoolEventSchema) })
  .openapi("SchoolEventList");

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

export const schoolEventListQuerySchema = z
  .object({
    from: dateSchema.openapi({ description: "Window start, inclusive (YYYY-MM-DD)." }),
    to: dateSchema.openapi({ description: "Window end, inclusive (YYYY-MM-DD)." }),
  })
  .superRefine((value, ctx) => {
    const span = daysBetween(value.from, value.to);
    if (span < 0) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "'to' must not be before 'from'" });
    } else if (span > MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `The window may span at most ${MAX_RANGE_DAYS} days`,
      });
    }
  });

const eventFields = {
  title: sanitizedTextSchema({ min: 1, minMessage: "Title is required", max: 200 }),
  description: sanitizedTextSchema({ max: 2000 }).nullable().optional(),
  kind: schoolEventKindSchema,
  starts_on: dateSchema,
  ends_on: dateSchema,
};

/** Mirrors ck_school_events_date_range (000121), so a bad range 400s with a field message. */
function refineRange(value: { starts_on?: string; ends_on?: string }, ctx: z.RefinementCtx) {
  if (value.starts_on !== undefined && value.ends_on !== undefined) {
    if (value.ends_on < value.starts_on) {
      ctx.addIssue({
        code: "custom",
        path: ["ends_on"],
        message: "The end date must be on or after the start date",
      });
    }
  }
}

export const createSchoolEventBodySchema = z
  .object(eventFields)
  .superRefine(refineRange)
  .openapi("CreateSchoolEventBody");

export const updateSchoolEventBodySchema = z
  .object(eventFields)
  .partial()
  .superRefine(refineRange)
  .openapi("UpdateSchoolEventBody");

export const schoolEventIdParamSchema = z.object({ eventId: uuidSchema });

export type CreateSchoolEventBody = z.infer<typeof createSchoolEventBodySchema>;
export type UpdateSchoolEventBody = z.infer<typeof updateSchoolEventBodySchema>;
export type SchoolEvent = z.infer<typeof schoolEventSchema>;
