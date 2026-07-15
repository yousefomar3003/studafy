// Global (non-tenant) foundation for the demo tenant plus the school's billing subscription. Countries
// and currencies are already seeded by migration 000005, so this module only references them. The
// school, plan, and plan_prices rows are global (no RLS); the subscription is tenant-scoped, so this
// module sets app.school_id (transaction-local) right after inserting the school, and that GUC then
// stays in effect for every later module in the same transaction.
import { seedDate, uuid } from "../support";

import type { SchoolCtx, Sql } from "../support";

// The demo tenant's stable slug. seed.ts checks for it up front and aborts if it already exists, so a
// re-run against an already-seeded database is a clean no-op rather than a partial write.
export const DEMO_SCHOOL_SLUG = "studafy-demo-academy";
export const DEMO_SCHOOL_NAME = "Studafy Demo Academy";

// ISO references chosen from the 000005 reference data. Any active row would do; these keep the demo
// coherent (a UAE school billing in AED).
const DEMO_COUNTRY_ALPHA2 = "AE";
const DEMO_CURRENCY_CODE = "AED";

export async function seedSchool(sql: Sql): Promise<SchoolCtx> {
  const [country] = await sql<{ id: string }[]>`
    SELECT id FROM app.countries WHERE alpha2_code = ${DEMO_COUNTRY_ALPHA2}
  `;
  const [currency] = await sql<{ id: string }[]>`
    SELECT id FROM app.currencies WHERE code = ${DEMO_CURRENCY_CODE}
  `;
  if (!country || !currency) {
    throw new Error(
      `reference data missing: country ${DEMO_COUNTRY_ALPHA2} or currency ${DEMO_CURRENCY_CODE} ` +
        "(did migration 000005 run?)",
    );
  }

  const planId = uuid();
  await sql`
    INSERT INTO app.plans ${sql({
      id: planId,
      code: "campus_pro",
      display_name: "Campus Pro",
      description: "Full-featured plan used by the demo tenant.",
      is_active: true,
    })}
  `;
  await sql`
    INSERT INTO app.plan_prices ${sql({
      id: uuid(),
      plan_id: planId,
      currency_id: currency.id,
      billing_interval: "monthly",
      amount_minor: 49900,
      is_active: true,
    })}
  `;

  const schoolId = uuid();
  await sql`
    INSERT INTO app.schools ${sql({
      id: schoolId,
      slug: DEMO_SCHOOL_SLUG,
      name: DEMO_SCHOOL_NAME,
      status: "active",
      country_id: country.id,
      default_currency_id: currency.id,
    })}
  `;

  // From here on every write is tenant-scoped. SET LOCAL persists for the whole transaction.
  await sql`SELECT set_config('app.school_id', ${schoolId}, true)`;

  await sql`
    INSERT INTO app.subscriptions ${sql({
      id: uuid(),
      school_id: schoolId,
      plan_id: planId,
      status: "active",
      current_period_start: seedDate(-15),
      current_period_end: seedDate(45),
    })}
  `;

  return {
    schoolId,
    schoolSlug: DEMO_SCHOOL_SLUG,
    countryId: country.id,
    currencyId: currency.id,
    planId,
  };
}
