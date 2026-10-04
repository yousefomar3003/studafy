// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { arCatalog, enCatalog } from "./catalog";

// i18next plural suffixes. Arabic needs more plural forms than English, so keys are compared on
// their base name: `items_one` in en is satisfied by any `items_*` in ar.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function leafKeys(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [prefix];
  return Object.entries(node).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

function baseKeys(catalog: unknown): Set<string> {
  return new Set(leafKeys(catalog).map((key) => key.replace(PLURAL_SUFFIX, "")));
}

describe("translation catalogs", () => {
  test("every English string has an Arabic translation", () => {
    const ar = baseKeys(arCatalog);
    const missing = [...baseKeys(enCatalog)].filter((key) => !ar.has(key));
    expect(missing).toEqual([]);
  });

  test("Arabic has no keys English lacks (stale or misspelled keys)", () => {
    const en = baseKeys(enCatalog);
    const extra = [...baseKeys(arCatalog)].filter((key) => !en.has(key));
    expect(extra).toEqual([]);
  });
});
