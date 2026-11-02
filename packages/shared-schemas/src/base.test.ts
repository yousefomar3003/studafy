// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { dateSchema, dateTimeSchema, moneySchema, uuidSchema } from "./base";

describe("uuidSchema", () => {
  test("accepts a valid UUID", () => {
    expect(uuidSchema.parse("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    );
  });

  test("rejects a non-UUID string", () => {
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("moneySchema", () => {
  test("round-trips through JSON", () => {
    const money = { amountMinor: 1299, currency: "USD" };
    const parsed = moneySchema.parse(money);
    expect(moneySchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(money);
  });

  test("rejects a non-integer amount", () => {
    expect(moneySchema.safeParse({ amountMinor: 12.99, currency: "USD" }).success).toBe(false);
  });

  test("rejects a malformed currency code", () => {
    expect(moneySchema.safeParse({ amountMinor: 100, currency: "usd" }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: 100, currency: "US" }).success).toBe(false);
  });
});

describe("dateSchema", () => {
  test("accepts an ISO calendar date", () => {
    expect(dateSchema.parse("2026-07-07")).toBe("2026-07-07");
  });

  test("rejects a date-time value", () => {
    expect(dateSchema.safeParse("2026-07-07T12:00:00Z").success).toBe(false);
  });
});

describe("dateTimeSchema", () => {
  test("round-trips an ISO date-time", () => {
    const value = "2026-07-07T12:00:00.000Z";
    const parsed = dateTimeSchema.parse(value);
    expect(dateTimeSchema.parse(JSON.parse(JSON.stringify(parsed)))).toBe(value);
  });

  test("rejects a bare date", () => {
    expect(dateTimeSchema.safeParse("2026-07-07").success).toBe(false);
  });
});
