import { FEATURE_KEYS, isFeatureKey } from "@studafy/constants";

import { withSystemTx } from "../../db/tenant-tx";

import type { Database, DatabasePools } from "../../db/client";
import type { Logger } from "../../logger";
import type { FeatureAudience, FeatureKey } from "@studafy/constants";

/**
 * The feature catalog: the super admin's per-feature settings (`app.features`) and every tier with
 * the features it includes (`app.plans` with an audience, `app.plan_features`).
 *
 * Global, small and edited rarely, so it is cached per process for {@link CATALOG_TTL_MS} rather
 * than versioned per school: a tier or feature-status edit reaches every pod within that window.
 * Grant changes -- who holds what -- are not catalog changes; they ride the entitlement versions
 * and apply immediately.
 */

export const CATALOG_TTL_MS = 30_000;

export const FEATURE_STATUSES = ["active", "paused", "hidden"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureSettings {
  displayName: string;
  status: FeatureStatus;
}

export interface Tier {
  id: string;
  /** `app.plans.code`; what a grant names. */
  code: string;
  audience: FeatureAudience;
  rank: number;
  includesAllFeatures: boolean;
  /** For sale. A retired tier keeps serving the grants that already point at it. */
  isActive: boolean;
  /** Explicit `app.plan_features` rows: feature key -> monthly limit (null = unlimited). */
  limits: Partial<Record<FeatureKey, number | null>>;
}

export interface FeatureCatalog {
  /** Settings per registered key. A key the sync has not inserted yet is absent (and active). */
  settings: Partial<Record<FeatureKey, FeatureSettings>>;
  /** Tiers by plan code. Plans without an audience (school plans) are not tiers and are absent. */
  tiers: Record<string, Tier>;
}

interface TierRow {
  id: string;
  code: string;
  audience: FeatureAudience;
  rank: number;
  includes_all_features: boolean;
  is_active: boolean;
}

function pool(database: Database | DatabasePools): Database {
  return typeof database === "function" ? database : database.primary;
}

/** Read the catalog. Global tables: readable by studafy_app with no tenant scope. */
export async function readFeatureCatalog(
  database: Database | DatabasePools,
): Promise<FeatureCatalog> {
  const sql = pool(database);

  const [featureRows, tierRows, limitRows] = await Promise.all([
    sql<{ key: string; display_name: string; status: FeatureStatus }[]>`
      SELECT key, display_name, status FROM app.features
    `,
    sql<TierRow[]>`
      SELECT id::text AS id, code, audience, rank::int AS rank, includes_all_features, is_active
      FROM app.plans
      WHERE audience IS NOT NULL
    `,
    sql<{ plan_id: string; feature_key: string; monthly_limit: number | null }[]>`
      SELECT pf.plan_id::text AS plan_id, pf.feature_key, pf.monthly_limit
      FROM app.plan_features AS pf
      JOIN app.plans AS p ON p.id = pf.plan_id
      WHERE p.audience IS NOT NULL
    `,
  ]);

  const settings: FeatureCatalog["settings"] = {};
  for (const row of featureRows) {
    // A row whose key has left the code list is a retired feature: kept in the database, ignored.
    if (isFeatureKey(row.key)) {
      settings[row.key] = { displayName: row.display_name, status: row.status };
    }
  }

  const tiersById = new Map<string, Tier>();
  for (const row of tierRows) {
    tiersById.set(row.id, {
      id: row.id,
      code: row.code,
      audience: row.audience,
      rank: row.rank,
      includesAllFeatures: row.includes_all_features,
      isActive: row.is_active,
      limits: {},
    });
  }
  for (const row of limitRows) {
    const tier = tiersById.get(row.plan_id);
    if (tier && isFeatureKey(row.feature_key)) tier.limits[row.feature_key] = row.monthly_limit;
  }

  const tiers: FeatureCatalog["tiers"] = {};
  for (const tier of tiersById.values()) tiers[tier.code] = tier;

  return { settings, tiers };
}

export interface FeatureCatalogSource {
  get(): Promise<FeatureCatalog>;
}

/**
 * A per-process cached catalog. Concurrent misses share one read; a failed refresh keeps serving the
 * last good catalog (logged) rather than failing every feature check over a global read.
 */
export function createFeatureCatalogSource(deps: {
  database: Database | DatabasePools;
  logger: Logger;
  ttlMs?: number;
  now?: () => number;
}): FeatureCatalogSource {
  const { database, logger, ttlMs = CATALOG_TTL_MS, now = Date.now } = deps;
  let cached: { catalog: FeatureCatalog; loadedAt: number } | null = null;
  let inflight: Promise<FeatureCatalog> | null = null;

  return {
    async get() {
      if (cached && now() - cached.loadedAt < ttlMs) return cached.catalog;
      if (inflight) return inflight;

      inflight = readFeatureCatalog(database)
        .then((catalog) => {
          cached = { catalog, loadedAt: now() };
          return catalog;
        })
        .catch((err: unknown) => {
          if (!cached) throw err;
          logger.warn({ err }, "feature catalog refresh failed; serving the previous catalog");
          return cached.catalog;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/**
 * Sync the code registry into `app.features` (run once at API boot).
 *
 * Insert-only: a key new to the code list gets a row with its default display name; an existing row
 * is never touched, so the super admin's display name and status survive every deploy, and a key
 * removed from the code list keeps its row (plan_features and usage meters reference it).
 *
 * Runs as studafy_admin because the table is read-only to studafy_app. Not audited: it is the
 * deploy itself changing the catalog, with no actor and no school to attribute a row to.
 *
 * @returns the keys inserted.
 */
export async function syncFeatureCatalog(
  database: Database | DatabasePools,
): Promise<FeatureKey[]> {
  return withSystemTx(database, async (tx) => {
    const rows = await tx<{ key: string }[]>`
      INSERT INTO app.features (key, display_name)
      SELECT * FROM unnest(${FEATURE_KEYS}::text[], ${FEATURE_KEYS.map(defaultDisplayName)}::text[])
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `;
    return rows.map((row) => row.key).filter(isFeatureKey);
  });
}

/** "study_tools" -> "Study tools". The super admin renames it in the console. */
export function defaultDisplayName(key: FeatureKey): string {
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
