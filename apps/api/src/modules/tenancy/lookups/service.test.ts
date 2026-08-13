/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { listCountries, listCurrencies } from "./service";

describe("Lookups service", () => {
  test("listCountries is a function", () => {
    expect(typeof listCountries).toBe("function");
  });

  test("listCurrencies is a function", () => {
    expect(typeof listCurrencies).toBe("function");
  });
});
