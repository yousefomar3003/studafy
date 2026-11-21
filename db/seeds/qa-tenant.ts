#!/usr/bin/env bun
// Staging QA tenants seed (QA-02): `bun run db:seed:qa`.
//
// Provisions the three QA schools (tenants.ts QA_TENANTS) through the same envelope as the other
// seeds, one transaction per school: School A and School B run the full demo dataset, the platform
// school holds only its SUPER_ADMIN. Guarded by an explicit confirmation plus environment and host
// checks (guard.ts assertQaSeedAllowed). Idempotent per school: one that already exists is left
// untouched and the command still succeeds, so it can run on every staging deploy.
//
// Accounts and login: docs/runbooks/qa-staging-access.md; token tooling: qa/.
import { populatePlatformStaff } from "./data/platform-staff";
import { assertQaSeedAllowed } from "./guard";
import { QA_SEED_CONFIRMATION } from "./qa-credentials";
import { runSeedCli, seedTenant } from "./seed";
import { QA_TENANTS } from "./tenants";

import type { SeedOptions, SeedResult } from "./seed";
import type { QaTenantProfile } from "./tenants";

export function seedQaTenant(
  tenant: QaTenantProfile,
  options: SeedOptions = {},
): Promise<SeedResult> {
  return seedTenant(
    tenant,
    (env, config) => assertQaSeedAllowed(env, config, QA_SEED_CONFIRMATION),
    options,
    tenant.qaSchool === "platform" ? populatePlatformStaff : undefined,
  );
}

// Stops at the first failure: the schools are independent transactions, so the ones already seeded
// stay, and a re-run picks up where this one stopped.
export async function main(): Promise<number> {
  for (const tenant of QA_TENANTS) {
    const result = await runSeedCli(tenant, () => seedQaTenant(tenant));
    if (!result) return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
