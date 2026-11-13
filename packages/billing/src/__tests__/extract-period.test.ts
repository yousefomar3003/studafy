// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { extractPeriod } from "../event-mapping";

const OCT_17 = 1_792_264_863;
const NOV_17 = 1_794_943_263;
const period = { start: new Date(OCT_17 * 1000), end: new Date(NOV_17 * 1000) };

describe("extractPeriod", () => {
  // The shapes below are what Stripe actually sent for a new AI add-on subscription (API version
  // 2026-09-30), recorded during a test-mode purchase.
  test("a first invoice: its own period is zero-length, the line item's is the real one", () => {
    expect(
      extractPeriod({
        period_start: OCT_17,
        period_end: OCT_17,
        lines: { data: [{ period: { start: OCT_17, end: NOV_17 } }] },
      }),
    ).toEqual(period);
  });

  test("a 2025+ subscription keeps its period on the first item", () => {
    expect(
      extractPeriod({
        items: { data: [{ current_period_start: OCT_17, current_period_end: NOV_17 }] },
      }),
    ).toEqual(period);
  });

  test("an older subscription keeps it on the object itself", () => {
    expect(extractPeriod({ current_period_start: OCT_17, current_period_end: NOV_17 })).toEqual(
      period,
    );
  });

  test("a plain invoice-level period still counts (store and Tap events carry this shape)", () => {
    expect(extractPeriod({ period_start: OCT_17, period_end: NOV_17 })).toEqual(period);
  });

  test("never pairs a start from one place with an end from another", () => {
    expect(
      extractPeriod({
        current_period_start: OCT_17,
        lines: { data: [{ period: { end: NOV_17 } }] },
      }),
    ).toBeNull();
  });

  test("an event with no well-ordered period says nothing about dates", () => {
    expect(extractPeriod({})).toBeNull();
    expect(extractPeriod({ period_start: NOV_17, period_end: OCT_17 })).toBeNull();
  });
});
