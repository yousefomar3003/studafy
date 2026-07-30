import { expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { mapStripeStatus } from "../stripe/webhook";

test("mapStripeStatus maps valid Stripe statuses correctly", () => {
  const cases: { input: string | undefined; expected: string | null }[] = [
    { input: "active", expected: "active" },
    { input: "past_due", expected: "past_due" },
    { input: "canceled", expected: "canceled" },
    { input: "incomplete", expected: "trialing" },
    { input: "incomplete_expired", expected: "expired" },
    { input: "trialing", expected: "trialing" },
    { input: "paused", expected: "grace_period" },
    { input: "unknown", expected: null },
    { input: undefined, expected: null },
  ];

  for (const { input, expected } of cases) {
    expect(mapStripeStatus(input)).toBe(expected);
  }
});
