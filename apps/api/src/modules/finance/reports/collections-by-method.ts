/**
 * Collections by payment method and day: what was received, how, and when. The cash-up and bank
 * match report. Read from app.payment_cache, the local read model of confirmed Payment Entries,
 * rather than from ERPNext: it answers while ERPNext is down and costs one indexed query, not a
 * report run. Only confirmed payments count; a reversed payment was a mistake and is left out, a
 * pending one has not settled yet.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { dateSchema } from "@studafy/shared-schemas";

import { standardResponses } from "../../../openapi/responses";
import { formatMinorUnits } from "../currency";

import type { TransactionSql } from "postgres";

/** The longest range one request may cover: a school year and a bit. */
export const COLLECTIONS_MAX_DAYS = 400;

const paymentModeOrOther = z
  .enum(["cash", "bank_transfer", "card_external"])
  .nullable()
  .openapi({
    description:
      "How the money was collected. Null for a payment recorded directly in ERPNext with a mode " +
      "of payment that is not one of Studafy's.",
  });

export const collectionsByMethodQuerySchema = z
  .object({
    from_date: dateSchema.openapi({ description: "First day, inclusive (YYYY-MM-DD)." }),
    to_date: dateSchema.openapi({ description: "Last day, inclusive (YYYY-MM-DD)." }),
  })
  .refine((q) => q.from_date <= q.to_date, {
    message: "from_date must be on or before to_date",
    path: ["to_date"],
  })
  .refine(
    (q) => (Date.parse(q.to_date) - Date.parse(q.from_date)) / 86_400_000 < COLLECTIONS_MAX_DAYS,
    { message: `The range may cover at most ${COLLECTIONS_MAX_DAYS} days`, path: ["to_date"] },
  )
  .openapi("CollectionsByMethodQuery");

const collectionsAmountShape = {
  currency: z.string().length(3),
  payment_mode: paymentModeOrOther,
  amount: z.string().openapi({ description: "Decimal string at the currency's precision." }),
  amount_minor: z.number().int(),
  count: z.number().int(),
};

export const collectionsByMethodRowSchema = z
  .object({ date: dateSchema, ...collectionsAmountShape })
  .openapi("CollectionsByMethodRow");

export const collectionsByMethodTotalSchema = z
  .object(collectionsAmountShape)
  .openapi("CollectionsByMethodTotal");

export const collectionsByMethodReportSchema = z
  .object({
    from_date: dateSchema,
    to_date: dateSchema,
    rows: z.array(collectionsByMethodRowSchema).openapi({
      description: "One row per day, currency and method that received money, oldest day first.",
    }),
    totals: z.array(collectionsByMethodTotalSchema).openapi({
      description: "The whole range per currency and method.",
    }),
  })
  .openapi("CollectionsByMethodReport");

export const collectionsByMethodRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/collections-by-method",
  tags: ["Finance"],
  operationId: "getFinanceCollectionsByMethod",
  summary: "Money received per day and payment method",
  description:
    "Confirmed payments between `from_date` and `to_date`, grouped by day, currency and payment " +
    "method, with totals for the range. Read from Studafy's payment records, so it answers while " +
    "ERPNext is unavailable. Reversed and pending payments are not counted.",
  security: [{ bearerAuth: [] }],
  request: { query: collectionsByMethodQuerySchema },
  responses: standardResponses(
    { 200: { description: "Collections by method.", schema: collectionsByMethodReportSchema } },
    [400, 401, 403, 500],
  ),
});

type PaymentModeOrOther = z.infer<typeof paymentModeOrOther>;

interface RawRow {
  date: string;
  currency: string;
  minor_unit: number;
  payment_mode: PaymentModeOrOther;
  amount_minor: string;
  count: number;
}

function amountFields(row: RawRow) {
  return {
    currency: row.currency,
    payment_mode: row.payment_mode,
    amount: formatMinorUnits(BigInt(row.amount_minor), row.minor_unit),
    amount_minor: Number(row.amount_minor),
    count: row.count,
  };
}

export async function collectionsByMethod(
  tx: TransactionSql,
  schoolId: string,
  range: { from_date: string; to_date: string },
): Promise<z.infer<typeof collectionsByMethodReportSchema>> {
  const rows = await tx<RawRow[]>`
    SELECT pc.payment_date::text AS date, c.code AS currency, c.minor_unit, pc.payment_mode,
           sum(pc.amount_minor)::text AS amount_minor, count(*)::int AS count
    FROM app.payment_cache AS pc
    JOIN app.currencies AS c ON c.id = pc.currency_id
    WHERE pc.school_id = ${schoolId}::uuid
      AND pc.status = 'confirmed'
      AND pc.payment_date BETWEEN ${range.from_date}::date AND ${range.to_date}::date
    GROUP BY pc.payment_date, c.code, c.minor_unit, pc.payment_mode
    ORDER BY pc.payment_date, c.code, pc.payment_mode NULLS LAST
  `;

  const totals = new Map<string, RawRow>();
  for (const row of rows) {
    const key = `${row.currency}:${row.payment_mode ?? ""}`;
    const sum = totals.get(key);
    if (sum) {
      sum.amount_minor = (BigInt(sum.amount_minor) + BigInt(row.amount_minor)).toString();
      sum.count += row.count;
    } else {
      totals.set(key, { ...row });
    }
  }

  return {
    from_date: range.from_date,
    to_date: range.to_date,
    rows: rows.map((row) => ({ date: row.date, ...amountFields(row) })),
    totals: [...totals.values()].map(amountFields),
  };
}
