#!/usr/bin/env bun
/**
 * A small, idempotent extra fixture for the critical-journeys E2E suite (ST-246), run by
 * `apps/web/e2e/critical/support/global-setup.ts` right after `bun run db:seed`.
 *
 * The demo tenant's seeded subscription (`db/seeds/data/school.ts`) is already on the one and only
 * plan the main seed creates ("campus_pro") — so the web billing UI's "Change plan" picker
 * (`ChangePlanModal.tsx`) would render exactly one radio, permanently disabled as the current plan,
 * and the subscription-checkout journey could never select a *different* plan to switch to. There is
 * no HTTP endpoint to create a plan (`plan-routes.ts` is read-only; plans are seed/ops data), so this
 * inserts a second one directly — the same global, non-RLS tables `seedSchool` itself writes to (see
 * that file's own header on why no tenant scope is needed here).
 */
import { randomUUID as uuid } from "node:crypto";

import { createClient } from "../../packages/db/src/client";
import { loadMigrationConfig } from "../../packages/db/src/config";

export const E2E_SECOND_PLAN_CODE = "campus_enterprise_e2e";

async function main(): Promise<void> {
  const config = loadMigrationConfig(process.env);
  const client = createClient(config, "studafy-e2e-fixtures");

  try {
    const [existing] = await client<{ id: string }[]>`
      SELECT id FROM app.plans WHERE code = ${E2E_SECOND_PLAN_CODE}
    `;
    if (existing) {
      console.log("[e2e-fixtures] second plan already present, skipping");
      return;
    }

    const [currency] = await client<{ id: string }[]>`
      SELECT id FROM app.currencies WHERE code = 'USD'
    `;
    if (!currency) throw new Error("USD currency not found — did migration 000005 run?");

    const planId = uuid();
    await client`
      INSERT INTO app.plans ${client({
        id: planId,
        code: E2E_SECOND_PLAN_CODE,
        display_name: "Campus Enterprise (E2E)",
        description:
          "Second plan for the ST-246 subscription-checkout journey's 'change plan' step.",
        is_active: true,
      })}
    `;
    await client`
      INSERT INTO app.plan_prices ${client({
        id: uuid(),
        plan_id: planId,
        currency_id: currency.id,
        billing_interval: "monthly",
        amount_minor: 99900,
        is_active: true,
      })}
    `;
    console.log("[e2e-fixtures] inserted second plan for the subscription-checkout journey");
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
