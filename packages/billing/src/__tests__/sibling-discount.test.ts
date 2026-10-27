// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { siblingPercentageFor, tierPercentageFor } from "../sibling-discount";

import type { SiblingDiscountRule, SiblingStanding } from "../sibling-discount";

const TIERS = [
  { child_position: 3, percentage: "15.00" },
  { child_position: 2, percentage: "10.00" },
];

function standing(position: number): SiblingStanding {
  return { student_id: "s", family_id: "f", child_position: position, sibling_count: position };
}

describe("tierPercentageFor", () => {
  test("the eldest child gets no tier", () => {
    expect(tierPercentageFor(1, TIERS)).toBeNull();
  });

  test("each position takes its own tier", () => {
    expect(tierPercentageFor(2, TIERS)).toBe("10.00");
    expect(tierPercentageFor(3, TIERS)).toBe("15.00");
  });

  test("a tier carries on to every later child", () => {
    expect(tierPercentageFor(4, TIERS)).toBe("15.00");
    expect(tierPercentageFor(9, TIERS)).toBe("15.00");
  });

  test("a gap before the first tier means no discount", () => {
    expect(tierPercentageFor(2, [{ child_position: 3, percentage: "20.00" }])).toBeNull();
  });

  test("no tiers means no discount", () => {
    expect(tierPercentageFor(5, [])).toBeNull();
  });
});

describe("siblingPercentageFor", () => {
  const rule: SiblingDiscountRule = { is_enabled: true, fee_category: null, tiers: TIERS };

  test("applies the tier for the child's position", () => {
    expect(siblingPercentageFor(rule, standing(2))).toBe("10.00");
  });

  test("a disabled rule gives nothing", () => {
    expect(siblingPercentageFor({ ...rule, is_enabled: false }, standing(3))).toBeNull();
  });

  test("an unconfigured rule or a child without siblings gives nothing", () => {
    expect(siblingPercentageFor(null, standing(3))).toBeNull();
    expect(siblingPercentageFor(rule, undefined)).toBeNull();
  });
});
