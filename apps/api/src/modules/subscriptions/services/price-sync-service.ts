import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort, SyncOutcome } from "../ports/payment-provider";

export type SyncCounts = Record<SyncOutcome, number>;

/**
 * `syncedPlans` / `syncedPrices` count the rows processed, which is all the endpoint returns (its
 * response shape feeds the generated web and mobile clients). The breakdown says what a run actually
 * did to Stripe: a repeated run should report everything `unchanged`.
 */
export interface SyncResult {
  syncedPlans: number;
  syncedPrices: number;
  products: SyncCounts;
  prices: SyncCounts;
  /** Prices retired because the local row no longer matches them (an amount change). */
  archivedPrices: number;
  errors: string[];
}

function emptyCounts(): SyncCounts {
  return { created: 0, updated: 0, unchanged: 0 };
}

/**
 * Publish every plan and plan price to the payment provider. Safe to run any number of times: the
 * provider reuses what it already holds (see `PaymentProviderPort.syncProduct`/`syncPrice`), and a
 * row's stored provider id is written only when it actually changes.
 */
export async function syncPlanPrices(
  database: Database,
  provider: PaymentProviderPort,
  logger: Logger,
): Promise<SyncResult> {
  const result: SyncResult = {
    syncedPlans: 0,
    syncedPrices: 0,
    products: emptyCounts(),
    prices: emptyCounts(),
    archivedPrices: 0,
    errors: [],
  };

  try {
    const plans = await database<
      {
        id: string;
        code: string;
        display_name: string;
        description: string | null;
        is_active: boolean;
        stripe_product_id: string | null;
      }[]
    >`
      SELECT id, code, display_name, description, is_active, stripe_product_id
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
          providerProductId: plan.stripe_product_id,
        });

        if (productResult.providerProductId !== plan.stripe_product_id) {
          await database`
            UPDATE app.plans
            SET stripe_product_id = ${productResult.providerProductId}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ${plan.id}::uuid
          `;
        }

        result.syncedPlans++;
        result.products[productResult.outcome]++;

        const prices = await database<
          {
            id: string;
            currency_id: string;
            billing_interval: string;
            amount_minor: number;
            is_active: boolean;
            currency_code: string;
            stripe_price_id: string | null;
          }[]
        >`
          SELECT
            pp.id,
            pp.currency_id,
            pp.billing_interval::text AS billing_interval,
            pp.amount_minor,
            pp.is_active,
            pp.stripe_price_id,
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
              providerPriceId: price.stripe_price_id,
            });

            if (priceResult.providerPriceId !== price.stripe_price_id) {
              await database`
                UPDATE app.plan_prices
                SET stripe_price_id = ${priceResult.providerPriceId}, updated_at = CURRENT_TIMESTAMP
                WHERE id = ${price.id}::uuid
              `;
            }

            result.syncedPrices++;
            result.prices[priceResult.outcome]++;
            result.archivedPrices += priceResult.archivedPriceIds.length;
            if (priceResult.archivedPriceIds.length > 0) {
              logger.info(
                { price_id: price.id, archived: priceResult.archivedPriceIds },
                "price sync archived superseded prices",
              );
            }
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

  const summary = {
    synced_plans: result.syncedPlans,
    synced_prices: result.syncedPrices,
    products: result.products,
    prices: result.prices,
    archived_prices: result.archivedPrices,
  };

  if (result.errors.length > 0) {
    // What did land is still worth knowing: a re-run picks up from it rather than redoing it.
    logger.warn({ ...summary, errors: result.errors.length }, "price sync completed with errors");
    throw new CodedHttpException(
      500,
      ERROR_CODES.STRIPE_PRICE_SYNC_FAILED,
      `Price sync completed with ${result.errors.length} error(s)`,
    );
  }

  logger.info(summary, "price sync completed successfully");

  return result;
}
