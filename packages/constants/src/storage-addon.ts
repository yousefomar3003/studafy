/**
 * The paid storage add-on's tiers (db/migrations/000205_storage_addon.sql).
 *
 * A school's upload cap is the larger of what its subscription includes
 * (`app.subscriptions.storage_cap_bytes`, 10 GiB by default) and the cap of a live storage add-on.
 * The plan codes here are the `app.plans` rows the add-on is sold as; their prices live in
 * `app.plan_prices`, one row per currency and billing interval.
 */

const GIB = 1024 * 1024 * 1024;

/** Storage every school has without buying anything: `app.subscriptions.storage_cap_bytes`'s default. */
export const INCLUDED_STORAGE_BYTES = 10 * GIB;

export const STORAGE_ADDON_TIERS = {
  storage_100gb: { capBytes: 100 * GIB },
  storage_1tb: { capBytes: 1024 * GIB },
} as const satisfies Record<string, { capBytes: number }>;

export type StorageAddonPlanCode = keyof typeof STORAGE_ADDON_TIERS;

export const STORAGE_ADDON_PLAN_CODES = Object.keys(STORAGE_ADDON_TIERS) as StorageAddonPlanCode[];

export function isStorageAddonPlanCode(code: string): code is StorageAddonPlanCode {
  return Object.prototype.hasOwnProperty.call(STORAGE_ADDON_TIERS, code);
}
