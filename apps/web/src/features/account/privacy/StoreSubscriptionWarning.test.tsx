import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { StoreSubscriptionWarning } from "./StoreSubscriptionWarning";

afterEach(cleanup);

const TITLE = "Cancel your App Store or Google Play subscription";

describe("StoreSubscriptionWarning", () => {
  test("renders nothing without a store subscription", () => {
    const { container } = render(<StoreSubscriptionWarning subscriptions={[]} />);
    expect(container.innerHTML).toBe("");
    render(<StoreSubscriptionWarning subscriptions={undefined} />);
    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
  });

  test("an own Google Play subscription: billed by the store, best-effort note, Play steps", () => {
    render(
      <StoreSubscriptionWarning subscriptions={[{ platform: "google_play", for_child: false }]} />,
    );

    expect(screen.getByRole("heading", { level: 3, name: TITLE })).toBeTruthy();
    expect(
      screen.getByText(/billed by Apple \(App Store\) or Google \(Google Play\)/),
    ).toBeTruthy();
    expect(screen.getByText(/we also try to stop the renewal/)).toBeTruthy();
    expect(screen.getByText(/^Google Play: open the Google Play app/)).toBeTruthy();
    expect(screen.queryByText(/^App Store:/)).toBeNull();
    expect(screen.queryByText(/A child linked to your account/)).toBeNull();
  });

  test("a parent's child's App Store subscription: the child text and App Store steps", () => {
    render(
      <StoreSubscriptionWarning
        headingLevel={2}
        subscriptions={[{ platform: "app_store", for_child: true }]}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: TITLE })).toBeTruthy();
    expect(screen.getByText(/A child linked to your account/)).toBeTruthy();
    expect(screen.getByText(/^App Store: on the iPhone or iPad/)).toBeTruthy();
    expect(screen.queryByText(/You have an AI Study Assistant subscription/)).toBeNull();
    expect(screen.queryByText(/we also try to stop the renewal/)).toBeNull();
  });
});
