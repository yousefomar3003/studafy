import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { RETAINED_RECORD_CATEGORIES, RETAINED_RECORD_CATEGORY_NAMES } from "../retention-policy";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../../../db/migrations");

const createdTables = new Set(
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .flatMap((file) =>
      [
        ...readFileSync(resolve(MIGRATIONS_DIR, file), "utf8").matchAll(
          /CREATE TABLE app\.([a-z_]+)/g,
        ),
      ].map((match) => match[1]!),
    ),
);

describe("RETAINED_RECORD_CATEGORIES", () => {
  test("covers each declared category exactly once", () => {
    expect(RETAINED_RECORD_CATEGORIES.map((c) => c.category)).toEqual([
      ...RETAINED_RECORD_CATEGORY_NAMES,
    ]);
  });

  test("names only tables that exist, so the disclosure cannot drift from the schema silently", () => {
    const missing = RETAINED_RECORD_CATEGORIES.flatMap((c) => c.tables).filter(
      (table) => !createdTables.has(table),
    );
    expect(missing).toEqual([]);
  });

  test("every category states its legal basis", () => {
    for (const category of RETAINED_RECORD_CATEGORIES) {
      expect(category.legalBasis).toContain("GDPR Art. 17(3)(b)");
    }
  });
});
