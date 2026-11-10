import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import { LanguageFlip } from "./LanguageFlip";
import { RegisterDemo } from "./RegisterDemo";
import { RoleTour } from "./RoleTour";
import { SensitiveDemo } from "./SensitiveDemo";

import type { ReactNode } from "react";

/**
 * The home page's live demos: each one does what it shows (a mark reaches the parent and the
 * attendance office, a role's screen works, the notification turns right-to-left, a reveal is
 * logged), works from the keyboard, and passes axe. happy-dom has no IntersectionObserver, so
 * nothing plays by itself here: every change comes from the test, as from a visitor.
 */

function renderInMain(node: ReactNode) {
  return render(<main>{node}</main>);
}

afterEach(cleanup);

describe("take the register", () => {
  test("marking a student reaches their parent's phone and the attendance office", async () => {
    const { container } = renderInMain(<RegisterDemo />);
    expect(screen.getByText("No new notifications")).toBeTruthy();
    expect(screen.getByText("Parent's phone")).toBeTruthy();

    const omar = screen.getByRole("radiogroup", { name: "Omar Haddad" });
    fireEvent.click(within(omar).getByLabelText("Absent"));
    expect(screen.getByText("Omar Haddad was marked absent in Science, period 2.")).toBeTruthy();
    expect(screen.getByText("Parent of Omar Haddad")).toBeTruthy();

    // The office's numbers moved with it.
    const counts = [...container.querySelectorAll(".mk-counts__item")].map((item) => [
      item.querySelector("dt")?.textContent,
      item.querySelector(".mk-counts__number")?.textContent,
    ]);
    expect(counts).toEqual([
      ["Present", "4"],
      ["Late", "0"],
      ["Absent", "1"],
    ]);

    // The same mark again sends nothing new.
    fireEvent.click(within(omar).getByLabelText("Absent"));
    expect(container.querySelectorAll(".mk-notice")).toHaveLength(1);

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Lina Saleh" })).getByLabelText("Late"),
    );
    expect(screen.getByText("Lina Saleh arrived late to Science, period 2.")).toBeTruthy();
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByText("Start again"));
    expect(screen.getByText("No new notifications")).toBeTruthy();
    expect((within(omar).getByLabelText("Present") as HTMLInputElement).checked).toBe(true);
  });
});

describe("the role tour", () => {
  test("arrow keys, Home and End move between the roles' tabs", async () => {
    const { container } = renderInMain(<RoleTour />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(7);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[0]!.id);

    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]!);

    fireEvent.keyDown(screen.getAllByRole("tab")[1]!, { key: "End" });
    expect(screen.getAllByRole("tab")[6]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getAllByRole("tab")[6]!, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[0]!.getAttribute("aria-selected")).toBe("true");
    await expectNoA11yViolations(container);
  });

  test("each role's screen works: approve marks, record a payment, take a register, hand in", () => {
    renderInMain(<RoleTour />);

    fireEvent.click(screen.getByRole("tab", { name: /Principal/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and release" }));
    expect(screen.getByRole("status").textContent).toBe("Released to families");

    fireEvent.click(screen.getByRole("tab", { name: /Finance/ }));
    expect(screen.getAllByText("Paid")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Record payment/ }));
    expect(screen.getAllByText("Paid")).toHaveLength(2);

    fireEvent.click(screen.getByRole("tab", { name: /Teacher/ }));
    fireEvent.click(screen.getByRole("button", { name: "Take register" }));
    expect(screen.getByRole("status").textContent).toBe("Register taken");

    fireEvent.click(screen.getByRole("tab", { name: /Student/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hand in" }));
    expect(screen.getByRole("status").textContent).toBe("Handed in");
  });
});

describe("the language flip", () => {
  test("shows the same notification in Arabic, right to left", async () => {
    const { container } = renderInMain(<LanguageFlip />);
    const card = () => container.querySelector(".mk-flip__card")!;
    expect(card().getAttribute("dir")).toBe("ltr");
    expect(card().textContent).toContain("Omar was marked absent");

    fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    expect(card().getAttribute("dir")).toBe("rtl");
    expect(card().getAttribute("lang")).toBe("ar");
    expect(card().textContent).toContain("تم تسجيل غياب عمر");
    expect(screen.getByRole("button", { name: "العربية" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await expectNoA11yViolations(container);
  });
});

describe("the sensitive field", () => {
  test("is masked until revealed, and every reveal is logged", async () => {
    const { container } = renderInMain(<SensitiveDemo />);
    expect(screen.getByText("•••• 4471")).toBeTruthy();
    expect(screen.getByText("Nothing revealed yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByText("9881204471")).toBeTruthy();
    expect(screen.getByText(/You revealed the National ID/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByText("•••• 4471")).toBeTruthy();
    // Hiding is not a reveal: still one entry.
    expect(container.querySelectorAll(".mk-secret__entry")).toHaveLength(1);
    await expectNoA11yViolations(container);
  });
});
