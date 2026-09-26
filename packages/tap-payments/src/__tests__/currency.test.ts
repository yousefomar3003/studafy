// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { fromTapAmount, TapAmountError, toTapAmount } from "../currency";

describe("toTapAmount", () => {
  test("converts minor units at the currency's precision", () => {
    expect(toTapAmount(15_500, "JOD")).toBe(15.5);
    expect(toTapAmount(1, "KWD")).toBe(0.001);
    expect(toTapAmount(1_999, "SAR")).toBe(19.99);
    expect(toTapAmount(1_999, "sar")).toBe(19.99);
  });

  test("refuses zero, negative, fractional amounts and unsettled currencies", () => {
    expect(() => toTapAmount(0, "JOD")).toThrow(TapAmountError);
    expect(() => toTapAmount(-5, "JOD")).toThrow(TapAmountError);
    expect(() => toTapAmount(1.5, "JOD")).toThrow(TapAmountError);
    expect(() => toTapAmount(100, "JPY")).toThrow(TapAmountError);
  });
});

describe("fromTapAmount", () => {
  test("is the inverse at each precision", () => {
    expect(fromTapAmount(15.5, "JOD")).toBe(15_500);
    expect(fromTapAmount(0.001, "KWD")).toBe(1);
    expect(fromTapAmount(19.99, "SAR")).toBe(1_999);
  });

  test("returns null for a currency Tap does not settle", () => {
    expect(fromTapAmount(1, "JPY")).toBeNull();
  });
});
