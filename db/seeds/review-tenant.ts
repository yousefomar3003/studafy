#!/usr/bin/env bun
// App Store / Play reviewer tenant seed (ST-303): `bun run db:seed:review`.
//
// Provisions the review tenant (tenants.ts REVIEW_TENANT) through the same envelope and data modules
// as the local demo seed. Intended for production; guarded by an explicit confirmation instead of
// the local-only host checks (guard.ts assertReviewSeedAllowed). Idempotent at the tenant level: if
// the tenant already exists nothing is written and the command still succeeds, so a deploy pipeline
// can run it on every release.
//
// Reviewer credentials: docs/runbooks/app-review-access.md.
import { assertReviewSeedAllowed } from "./guard";
import { runSeedCli, seedTenant } from "./seed";
import { REVIEW_TENANT } from "./tenants";

import type { SeedOptions, SeedResult } from "./seed";

export function seedReviewTenant(options: SeedOptions = {}): Promise<SeedResult> {
  return seedTenant(
    REVIEW_TENANT,
    (env) => assertReviewSeedAllowed(env, REVIEW_TENANT.slug),
    options,
  );
}

export async function main(): Promise<number> {
  const result = await runSeedCli(REVIEW_TENANT, () => seedReviewTenant());
  return result ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
