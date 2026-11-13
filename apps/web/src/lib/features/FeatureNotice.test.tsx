import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { feature, features, grant } from "../test/feature-fixtures";

import { FeatureNotice } from "./FeatureNotice";
import { featureGateState } from "./gate";

import type { MyFeature } from "./gate";

/**
 * What a paid feature's page says, one state each -- and never a purchase control in any of them:
 * "Provided by" the school with usage, the subscription that won't renew (and the App Store steps),
 * the limit reached, "ask your school for a seat", school inactive, paused, access ended.
 */

const NOW = new Date("2026-10-27T09:00:00.000Z");

function renderFor(f: MyFeature) {
  return render(
    <FeatureNotice state={featureGateState(features([f]), "ai_tutor", NOW)} unitLabel="messages" />,
  );
}

function expectNoPurchase() {
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
}

afterEach(cleanup);

describe("FeatureNotice", () => {
  test("covered by a seat: provided by the school, and this month's usage", () => {
    renderFor(
      feature({
        active: true,
        reason: null,
        sources: [grant("school_license", undefined, 300)],
        limit: 300,
        used: 120,
        schoolSeat: true,
      }),
    );
    expect(screen.getByText("Provided by Alpha Academy")).toBeTruthy();
    expect(screen.getByText("120 of 300 messages used this month")).toBeTruthy();
    expectNoPurchase();
  });

  test("covered by both: the subscription won't renew after its end date", () => {
    renderFor(
      feature({
        active: true,
        reason: null,
        sources: [grant("school_license"), grant("purchase", "2026-11-20T00:00:00.000Z")],
        schoolSeat: true,
        renewalStop: { provider: "stripe", action: "cancel_at_period_end", status: "done" },
      }),
    );
    expect(
      screen.getByText(
        "Your school now covers this. Your subscription won't renew after November 20, 2026.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/App Store/)).toBeNull();
  });

  test("covered by both through the App Store: how to turn renewal off, as text", () => {
    renderFor(
      feature({
        active: true,
        reason: null,
        sources: [grant("school_license"), grant("purchase")],
        schoolSeat: true,
        renewalStop: { provider: "app_store", action: "notify_user", status: "notified" },
      }),
    );
    expect(screen.getByText(/Apple doesn't let Studafy stop App Store renewals/)).toBeTruthy();
    expectNoPurchase();
  });

  test("limit reached: resets on the 1st", () => {
    renderFor(
      feature({
        active: true,
        reason: "limit_reached",
        sources: [grant("school_license", undefined, 300)],
        limit: 300,
        used: 300,
      }),
    );
    expect(screen.getByText("Monthly limit reached, resets on November 1, 2026.")).toBeTruthy();
  });

  test("the school provides it: ask for a seat, nothing to buy", () => {
    renderFor(feature({ schoolOffers: true }));
    expect(screen.getByText("Ask your school for a seat")).toBeTruthy();
    expect(
      screen.getByText(/Alpha Academy provides this through its Studafy license/),
    ).toBeTruthy();
    expectNoPurchase();
  });

  test("a seat whose tier lacks it: ask about another plan", () => {
    renderFor(feature({ schoolSeat: true }));
    expect(screen.getByText(/Your seat from Alpha Academy doesn't include this/)).toBeTruthy();
    expectNoPurchase();
  });

  test("school inactive and paused", () => {
    renderFor(feature({ reason: "school_inactive" }));
    expect(screen.getByText("Your school's Studafy plan isn't active")).toBeTruthy();
    cleanup();
    renderFor(feature({ reason: "paused" }));
    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
  });

  test("purchasable: nothing of its own, or when access ended", () => {
    const { container } = renderFor(feature());
    expect(container.textContent).toBe("");
    cleanup();
    renderFor(feature({ reason: "expired", periodEnd: "2026-10-01T00:00:00.000Z" }));
    expect(screen.getByText("Your access ended on October 1, 2026.")).toBeTruthy();
  });

  test("personally covered with nothing to count: nothing to say", () => {
    const { container } = renderFor(
      feature({ active: true, reason: null, unit: null, sources: [grant("purchase")] }),
    );
    expect(container.textContent).toBe("");
  });
});
