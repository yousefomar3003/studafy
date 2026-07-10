import { render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { expectNoA11yViolations } from "./axe";

/**
 * Guards the accessibility gate itself. The failing case is the important one: it proves axe can
 * actually report a violation under happy-dom, so a green suite means something. Without it, a
 * misconfigured helper would let every component "pass" silently.
 */
describe("expectNoA11yViolations", () => {
  test("passes for accessible markup", async () => {
    const { container } = render(
      <main>
        <button type="button">Save</button>
      </main>,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    await expectNoA11yViolations(container);
  });

  test("fails for a control with no accessible name", async () => {
    const { container } = render(
      <main>
        <input type="text" />
      </main>,
    );

    await expect(expectNoA11yViolations(container)).rejects.toThrow(/accessibility violations/);
  });
});
