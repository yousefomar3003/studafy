// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { defaultPricingCurrency } from "./currency";

describe("the pricing card's first currency", () => {
  test("follows the browser's region where it clearly maps to one we show", () => {
    expect(defaultPricingCurrency(["ar-JO"])).toBe("JOD");
    expect(defaultPricingCurrency(["en-JO"])).toBe("JOD");
    expect(defaultPricingCurrency(["ar-SA"])).toBe("SAR");
    expect(defaultPricingCurrency(["en-GB"])).toBe("GBP");
    expect(defaultPricingCurrency(["de-DE"])).toBe("EUR");
    expect(defaultPricingCurrency(["fr-FR"])).toBe("EUR");
    expect(defaultPricingCurrency(["en-IE"])).toBe("EUR");
    expect(defaultPricingCurrency(["bg-BG"])).toBe("EUR");
    expect(defaultPricingCurrency(["zh-Hant-AT"])).toBe("EUR");
  });

  test("is USD for any other region", () => {
    expect(defaultPricingCurrency(["en-US"])).toBe("USD");
    expect(defaultPricingCurrency(["ar-EG"])).toBe("USD");
    expect(defaultPricingCurrency(["ar-AE"])).toBe("USD");
    // In Europe, but not on the euro.
    expect(defaultPricingCurrency(["de-CH"])).toBe("USD");
    expect(defaultPricingCurrency(["sv-SE"])).toBe("USD");
  });

  test("is USD when no tag names a region", () => {
    expect(defaultPricingCurrency([])).toBe("USD");
    expect(defaultPricingCurrency(["ar"])).toBe("USD");
    expect(defaultPricingCurrency(["en"])).toBe("USD");
    expect(defaultPricingCurrency(["not a locale"])).toBe("USD");
  });

  test("the first tag that names a region decides", () => {
    expect(defaultPricingCurrency(["ar", "ar-JO", "en-US"])).toBe("JOD");
    expect(defaultPricingCurrency(["en-US", "ar-JO"])).toBe("USD");
    expect(defaultPricingCurrency(["???", "en-GB"])).toBe("GBP");
  });
});
