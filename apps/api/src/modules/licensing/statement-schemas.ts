import { z } from "@hono/zod-openapi";

import { STATEMENT_STATUSES } from "./statements";

/**
 * OpenAPI schemas for the Student AI weekly statements (000251). As in revenue-share-schemas.ts:
 * every nested object and every enum has its own `.openapi("Name")`, and a nullable enum stays
 * inline (a nullable reference to a named enum breaks the Dart client generator).
 */

const uuid = z.string().uuid();
const int = z.number().int();
const minor = int.openapi({ description: "Minor units of the currency (cents)." });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pathUuid = (name: string) => uuid.openapi({ param: { name, in: "path" } });

export const statementStatusSchema = z
  .enum(STATEMENT_STATUSES)
  .openapi("AiRevenueShareStatementStatus");

export const statementParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  statementId: pathUuid("statementId"),
});

export const statementListQuerySchema = z.object({
  status: statementStatusSchema.optional().openapi({ param: { name: "status", in: "query" } }),
});

const statementFields = {
  id: uuid,
  schoolId: uuid,
  weekStart: day,
  weekEnd: day,
  currencyCode: z.string(),
  minorUnit: int,
  monthsCount: int,
  grossMinor: minor,
  shareMinor: minor,
  netMinor: minor,
  licenceShareCount: int,
  licenceShareMinor: minor,
  status: statementStatusSchema,
  decidedAt: z.string().nullable(),
  decidedBy: uuid.nullable(),
  decisionNote: z.string().nullable(),
  invoiceId: uuid.nullable(),
  invoiceNumber: z.string().nullable(),
  createdAt: z.string(),
};

export const statementSchema = z.object(statementFields).openapi("AiRevenueShareStatement");

export const platformStatementSchema = z
  .object({ ...statementFields, schoolName: z.string() })
  .openapi("PlatformAiRevenueShareStatement");

export const platformStatementListSchema = z
  .object({ statements: z.array(platformStatementSchema) })
  .openapi("PlatformAiRevenueShareStatementList");

export const schoolStatementListSchema = z
  .object({ statements: z.array(statementSchema) })
  .openapi("AiRevenueShareStatementList");

export const statementMonthSchema = z
  .object({
    id: uuid,
    studentId: uuid,
    studentName: z.string(),
    month: day,
    collectedOn: day,
    priceMinor: minor,
    shareBps: int.nullable(),
    shareMinor: int.nullable(),
    status: z.enum(["collected", "billed", "activated", "void"]).openapi("StudentAiMonthStatus"),
  })
  .openapi("AiRevenueShareStatementMonth");

export const statementShareSchema = z
  .object({
    id: uuid,
    licenseId: uuid,
    invoiceNumber: z.string(),
    periodFrom: day,
    periodTo: day,
    measurementPeriodStart: day,
    totalBps: int,
    amountMinor: minor,
    status: z.string(),
  })
  .openapi("AiRevenueShareStatementShare");

export const statementDetailSchema = z
  .object({
    ...statementFields,
    months: z.array(statementMonthSchema),
    shares: z.array(statementShareSchema),
  })
  .openapi("AiRevenueShareStatementDetail");

export const approveStatementBodySchema = z
  .object({
    expectedNetMinor: minor,
    expectedLicenceShareMinor: minor,
    note: z.string().max(1000).nullable().optional(),
  })
  .openapi("AiRevenueShareStatementApproveBody");

export const holdStatementBodySchema = z
  .object({ note: z.string().max(1000) })
  .openapi("AiRevenueShareStatementHoldBody");

export const rejectStatementBodySchema = z
  .object({ reason: z.string().max(1000) })
  .openapi("AiRevenueShareStatementRejectBody");
