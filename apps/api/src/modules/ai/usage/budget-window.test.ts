// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { monthlyBudgetWindow } from "./budget-window";

const at = (iso: string) => new Date(iso);

describe("monthlyBudgetWindow", () => {
  test("a monthly subscription is one window, returned unchanged (same meter key as before)", () => {
    const start = "2026-08-10T00:00:00.000Z";
    const end = "2026-09-10T00:00:00.000Z";
    for (const now of [
      "2026-08-10T00:00:00.000Z",
      "2026-08-25T12:00:00.000Z",
      "2026-09-09T23:59:00.000Z",
    ]) {
      expect(monthlyBudgetWindow(start, end, at(now))).toEqual({
        periodStart: start,
        periodEnd: end,
      });
    }
  });

  test("a provider month a day longer or shorter stays one window", () => {
    expect(
      monthlyBudgetWindow(
        "2026-01-31T08:00:00.000Z",
        "2026-03-01T08:00:00.000Z",
        at("2026-02-28T12:00:00.000Z"),
      ),
    ).toEqual({ periodStart: "2026-01-31T08:00:00.000Z", periodEnd: "2026-03-01T08:00:00.000Z" });
  });

  test("a yearly subscription resets every month", () => {
    const start = "2026-01-15T10:00:00.000Z";
    const end = "2027-01-15T10:00:00.000Z";
    expect(monthlyBudgetWindow(start, end, at("2026-01-20T00:00:00.000Z"))).toEqual({
      periodStart: start,
      periodEnd: "2026-02-15T10:00:00.000Z",
    });
    expect(monthlyBudgetWindow(start, end, at("2026-11-13T00:00:00.000Z"))).toEqual({
      periodStart: "2026-10-15T10:00:00.000Z",
      periodEnd: "2026-11-15T10:00:00.000Z",
    });
    expect(monthlyBudgetWindow(start, end, at("2026-12-20T00:00:00.000Z"))).toEqual({
      periodStart: "2026-12-15T10:00:00.000Z",
      periodEnd: end,
    });
  });

  test("the window boundary belongs to the new window", () => {
    expect(
      monthlyBudgetWindow(
        "2026-01-15T10:00:00.000Z",
        "2027-01-15T10:00:00.000Z",
        at("2026-03-15T10:00:00.000Z"),
      ).periodStart,
    ).toBe("2026-03-15T10:00:00.000Z");
  });

  test("a 31st anchor clamps to short months without drifting", () => {
    const start = "2026-01-31T00:00:00.000Z";
    const end = "2027-01-31T00:00:00.000Z";
    expect(monthlyBudgetWindow(start, end, at("2026-02-28T12:00:00.000Z"))).toEqual({
      periodStart: "2026-02-28T00:00:00.000Z",
      periodEnd: "2026-03-31T00:00:00.000Z",
    });
    expect(monthlyBudgetWindow(start, end, at("2026-04-05T00:00:00.000Z"))).toEqual({
      periodStart: "2026-03-31T00:00:00.000Z",
      periodEnd: "2026-04-30T00:00:00.000Z",
    });
  });

  test("a short tail is folded into the last full window", () => {
    // School license 2026-09-01 -> 2027-06-04: the 3 days after 2027-06-01 are not their own window.
    const start = "2026-09-01T00:00:00.000Z";
    const end = "2027-06-04T00:00:00.000Z";
    expect(monthlyBudgetWindow(start, end, at("2027-06-02T00:00:00.000Z"))).toEqual({
      periodStart: "2027-05-01T00:00:00.000Z",
      periodEnd: end,
    });
  });

  test("a clock outside the period clamps to the first or last window", () => {
    const start = "2026-01-15T10:00:00.000Z";
    const end = "2027-01-15T10:00:00.000Z";
    expect(monthlyBudgetWindow(start, end, at("2025-12-01T00:00:00.000Z")).periodStart).toBe(start);
    expect(monthlyBudgetWindow(start, end, at("2027-03-01T00:00:00.000Z"))).toEqual({
      periodStart: "2026-12-15T10:00:00.000Z",
      periodEnd: end,
    });
  });

  test("an unparseable or empty period is returned unchanged", () => {
    expect(monthlyBudgetWindow("bad", "2026-01-01T00:00:00.000Z")).toEqual({
      periodStart: "bad",
      periodEnd: "2026-01-01T00:00:00.000Z",
    });
    expect(monthlyBudgetWindow("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toEqual({
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-01-01T00:00:00.000Z",
    });
  });
});
