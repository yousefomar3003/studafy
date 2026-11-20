import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import { PlatformNav } from "./PlatformNav";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <main>
        <PlatformNav />
      </main>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("PlatformNav", () => {
  test("groups the sections behind one button each, after a standalone Overview link", async () => {
    const { container } = renderAt("/portal/platform");
    const nav = screen.getByRole("navigation", { name: "Platform console sections" });
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
    const billing = within(nav).getByRole("button", { name: /Billing/ });
    expect(billing.getAttribute("aria-expanded")).toBe("false");
    // Sections stay out of the page until their group is opened.
    expect(within(nav).queryByRole("link", { name: "Refunds" })).toBeNull();

    fireEvent.click(billing);
    expect(within(nav).getByRole("link", { name: "Refunds" }).getAttribute("href")).toBe(
      "/portal/platform/refunds",
    );
    await expectNoA11yViolations(container);
  });

  test("marks the group holding the current section, and the section inside it", () => {
    renderAt("/portal/platform/refunds/42");
    const nav = screen.getByRole("navigation", { name: "Platform console sections" });
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      null,
    );
    const billing = within(nav).getByRole("button", { name: /Billing/ });
    expect(billing.hasAttribute("data-current")).toBe(true);
    expect(
      within(nav)
        .getByRole("button", { name: /Operations/ })
        .hasAttribute("data-current"),
    ).toBe(false);

    fireEvent.click(billing);
    expect(within(nav).getByRole("link", { name: "Refunds" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  test("matches the Student AI home exactly, apart from its schools and statements", () => {
    renderAt("/portal/platform/ai-programme/schools");
    fireEvent.click(screen.getByRole("button", { name: /^AI/ }));
    expect(screen.getByRole("link", { name: "Student AI" }).getAttribute("aria-current")).toBe(
      null,
    );
    expect(
      screen.getByRole("link", { name: "Student AI schools" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
