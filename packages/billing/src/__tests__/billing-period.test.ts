// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { addBillingInterval, isBillingInterval } from "../billing-period";

const utc = (iso: string) => new Date(iso);

describe("addBillingInterval", () => {
  test("adds a calendar month, preserving time of day", () => {
    expect(addBillingInterval(utc("2026-03-15T10:30:00.000Z"), "monthly").toISOString()).toBe(
      "2026-04-15T10:30:00.000Z",
    );
  });

  test("clamps to the last day of a shorter month", () => {
    expect(addBillingInterval(utc("2026-01-31T00:00:00.000Z"), "monthly").toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(addBillingInterval(utc("2028-01-31T00:00:00.000Z"), "monthly").toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  test("rolls over the year", () => {
    expect(addBillingInterval(utc("2026-12-10T00:00:00.000Z"), "monthly").toISOString()).toBe(
      "2027-01-10T00:00:00.000Z",
    );
  });

  test("adds a year, clamping 29 February", () => {
    expect(addBillingInterval(utc("2028-02-29T08:00:00.000Z"), "yearly").toISOString()).toBe(
      "2029-02-28T08:00:00.000Z",
    );
  });

  test("recognises exactly the app.billing_interval values, not the port's month/year", () => {
    expect(isBillingInterval("monthly")).toBe(true);
    expect(isBillingInterval("yearly")).toBe(true);
    expect(isBillingInterval("month")).toBe(false);
    expect(isBillingInterval(undefined)).toBe(false);
  });
});
