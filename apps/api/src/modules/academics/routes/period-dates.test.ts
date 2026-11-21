// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { withPeriodDates } from "./period-dates";

describe("withPeriodDates", () => {
  test("a year or term's dates are calendar days, never timestamps", () => {
    const row = { id: "t1", starts_on: new Date("2026-07-01"), ends_on: new Date("2026-12-31") };
    expect(withPeriodDates(row)).toEqual({
      id: "t1",
      starts_on: "2026-07-01",
      ends_on: "2026-12-31",
    });
  });

  test("a value that is already a day passes through", () => {
    expect(withPeriodDates({ starts_on: "2026-07-01", ends_on: "2026-12-31" })).toEqual({
      starts_on: "2026-07-01",
      ends_on: "2026-12-31",
    });
  });
});
