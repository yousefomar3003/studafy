/**
 * QA-082: the store declarations kept in the repository must not contradict the shipped code.
 *
 * The IARC answers said "Digital purchases: No" while the app ships `in_app_purchase` and sells
 * the AI add-on; the Data safety answers said the app has no per-user deletion action while every
 * role can open Delete account; and the children's-data dossier said DSR export bundles are never
 * purged while the retention sweep deletes them after 30 days. Each check below reads the code fact
 * and the declaration together, so a future change to either side fails here first.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("store declarations match the code (QA-082)", () => {
  test("in-app purchases are declared when the app ships them", () => {
    const shipsPurchases = /^ {2}in_app_purchase:/mu.test(read("apps/mobile/pubspec.lock"));
    const row = read("docs/compliance/store-audience-and-age-ratings.md")
      .split("\n")
      .find((line) => line.startsWith("| Digital purchases"));
    expect(row).toBeDefined();
    expect(row!.includes("**Yes**")).toBe(shipsPurchases);
  });

  test("Data safety does not deny the in-app account deletion", () => {
    const appDeletes = existsSync(
      resolve(root, "apps/mobile/lib/src/features/shell/presentation/delete_account_screen.dart"),
    );
    const labels = read("apps/mobile/store/privacy-labels.md");
    if (appDeletes) expect(labels).not.toContain("has no per-user deletion action");
  });

  test("the dossier does not call purged DSR export bundles permanent", () => {
    const sweepPurgesExports = /DSR_EXPORT_RETENTION_DAYS = \d+/u.test(
      read("apps/workers/src/queues/maintenance/data-retention-sweep.ts"),
    );
    const dossier = read("docs/compliance/childrens-data-dossier.md");
    if (sweepPurgesExports) expect(dossier).not.toContain("They are never purged");
  });
});
