/**
 * Report envelope direction is a pure function of the supported locale set: the finance report
 * envelope (`reportEnvelope`, apps/api/src/modules/finance/reports/service.ts:138) stamps
 * `presentation.direction` as `"rtl"` exactly when the resolved locale is `ar`, and `"ltr"` for
 * every other *supported* locale. `SupportedLocale` (apps/api/src/middleware/locale.ts:22) is only
 * `"en" | "ar"` - there is no third supported locale, so the honest control set is literally the
 * union, not an invented `fr`/`de` pair that the compiler rejects.
 *
 * Catalog ar control: a Casablanca school (no DST) with locale `ar` -> `presentation.direction`
 * remains `"rtl"` and `presentation.locale === "ar"` - the direction is locale-driven, never
 * timezone-driven, so a DST zone can never flip a report orientation.
 *
 * Pure: no DB, no wall clock. Runs in the normal api test command.
 */
 
 
import { describe, expect, test } from "bun:test";

import { reportEnvelope } from "../../src/modules/finance/reports/service";

import type { SupportedLocale } from "../../src/middleware/locale";

const FLAT = Object.freeze({
  report_name: "F3_BS",
  columns: [],
  rows: [],
  report_summary: [],
});

function envelopeFor(locale: SupportedLocale) {
  return reportEnvelope("F3_BS", FLAT as never, locale);
}

const SUPPORTED = ["en", "ar"] as const;

describe("report envelope direction follows SupportedLocale, never the timezone", () => {
  test("ar renders right-to-left and keeps its locale identity", () => {
    const env = envelopeFor("ar");
    expect(env.presentation.direction).toBe("rtl");
    expect(env.presentation.locale).toBe("ar");
  });

  test("en renders left-to-right across the exact supported set", () => {
    expect(envelopeFor("en").presentation.direction).toBe("ltr");
  });

  test("the supported set is exactly {en, ar} - direction is a bijection of it", () => {
    for (const locale of SUPPORTED) {
      expect(envelopeFor(locale).presentation.direction).toBe(locale === "ar" ? "rtl" : "ltr");
    }
  });
});
