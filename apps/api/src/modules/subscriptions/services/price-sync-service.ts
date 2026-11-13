import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort } from "../ports/payment-provider";

export interface SyncResult {
  syncedPlans: number;
  syncedPrices: number;
  errors: string[];
}

export async function syncPlanPrices(
  database: Database,
  provider: PaymentProviderPort,
  logger: Logger,
): Promise<SyncResult> {
  const result: SyncResult = { syncedPlans: 0, syncedPrices: 0, errors: [] };

  try {
    const plans = await database<
      {
        id: string;
        code: string;
        display_name: string;
        description: string | null;
        is_active: boolean;
      }[]
    >`
      SELECT id, code, display_name, description, is_active
      FROM app.plans
      ORDER BY code
    `;

    for (const plan of plans) {
      try {
        const productResult = await provider.syncProduct({
          localId: plan.id,
          name: plan.display_name,
          description: plan.description ?? undefined,
          active: plan.is_active,
        });

        await database`
          UPDATE app.plans
          SET stripe_product_id = ${productResult.providerProductId}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${plan.id}::uuid
        `;

        result.syncedPlans++;

        const prices = await database<
          {
            id: string;
            currency_id: string;
            billing_interval: string;
            amount_minor: number;
            is_active: boolean;
            currency_code: string;
          }[]
        >`
          SELECT
            pp.id,
            pp.currency_id,
            pp.billing_interval::text AS billing_interval,
            pp.amount_minor,
            pp.is_active,
            c.code AS currency_code
          FROM app.plan_prices pp
          JOIN app.currencies c ON c.id = pp.currency_id
          WHERE pp.plan_id = ${plan.id}::uuid
          ORDER BY pp.billing_interval
        `;

        for (const price of prices) {
          try {
            const priceResult = await provider.syncPrice({
              localId: price.id,
              productId: productResult.providerProductId,
              amountMinor: Number(price.amount_minor),
              currency: price.currency_code,
              interval: price.billing_interval === "yearly" ? "year" : "month",
              active: price.is_active,
            });

            await database`
              UPDATE app.plan_prices
              SET stripe_price_id = ${priceResult.providerPriceId}, updated_at = CURRENT_TIMESTAMP
              WHERE id = ${price.id}::uuid
            `;

            result.syncedPrices++;
          } catch (error) {
            const msg = error instanceof Error ? error.message : "unknown error";
            result.errors.push(`price ${price.id} (plan ${plan.code}): ${msg}`);
            logger.error({ error, plan_id: plan.id, price_id: price.id }, "price sync failed");
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown error";
        result.errors.push(`plan ${plan.code}: ${msg}`);
        logger.error({ error, plan_id: plan.id }, "plan sync failed");
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    result.errors.push(`database query failed: ${msg}`);
    logger.error({ error }, "price sync database query failed");
  }

  if (result.errors.length > 0) {
    throw new CodedHttpException(
      500,
      ERROR_CODES.STRIPE_PRICE_SYNC_FAILED,
      `Price sync completed with ${result.errors.length} error(s)`,
    );
  }

  logger.info(
    { synced_plans: result.syncedPlans, synced_prices: result.syncedPrices },
    "price sync completed successfully",
  );

  return result;
}
