import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import { FEATURE_DEMOS } from "./FeatureDemos";
import { SchoolSize } from "./SchoolSize";
import { StartSteps } from "./StartSteps";

import type { ComponentType } from "react";

/**
 * The features, pricing and about pages' working examples: each does what it shows, works from
 * the keyboard and passes axe.
 */

function renderDemo(id: string) {
  const Demo = FEATURE_DEMOS[id] as ComponentType;
  return render(
    <main>
      <Demo />
    </main>,
  );
}

afterEach(cleanup);

describe("features: one working example per area", () => {
  test("there is one for every area, and each passes axe", async () => {
    expect(Object.keys(FEATURE_DEMOS).sort()).toEqual(
      [
        "academics",
        "announcements",
        "attendance",
        "discipline",
        "exams",
        "families",
        "finance",
        "homework",
        "imports",
        "oversight",
        "records",
      ].sort(),
    );
    for (const id of Object.keys(FEATURE_DEMOS)) {
      const { container, unmount } = renderDemo(id);
      await expectNoA11yViolations(container);
      unmount();
    }
  }, 60_000);

  test("academics places a lesson in the first free slot, until the week is full", () => {
    renderDemo("academics");
    const place = screen.getByRole("button", { name: "Place a Science lesson" });
    fireEvent.click(place);
    expect(screen.getByRole("status").textContent).toBe(
      "Placed on Mon, period 3: the teacher and the room are both free then.",
    );
    for (let i = 0; i < 5; i += 1) fireEvent.click(place);
    expect(screen.getByRole("status").textContent).toBe("The week is full.");
    expect((place as HTMLButtonElement).disabled).toBe(true);
  });

  test("attendance corrects a mark with a reason, and keeps the history", () => {
    renderDemo("attendance");
    fireEvent.click(screen.getByRole("button", { name: "Correct this mark" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "doctor" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(
      screen.getByText("Absent → Late · Doctor's appointment · by the attendance office"),
    ).toBeTruthy();
    expect(screen.getByText("Late")).toBeTruthy();
  });

  test("exams weigh the term mark, and refuse weights that do not add up to 100%", () => {
    renderDemo("exams");
    // 88 x 30% + 74 x 30% + 81 x 40% = 81
    expect(document.querySelector("output")?.textContent).toBe("81");
    fireEvent.change(screen.getByLabelText(/Coursework/), {
      target: { value: "50" },
    });
    expect(document.querySelector("output")?.textContent).toBe("—");
    expect(screen.getByText(/add up to 120%/)).toBeTruthy();
  });

  test("finance splits the year's fee into instalments, with VAT when asked", () => {
    renderDemo("finance");
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(screen.getAllByText(/^Due /)).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("Add VAT (16%)"));
    expect(screen.getByText("JOD 2,088")).toBeTruthy();
  });

  test("announcements say who they reach, and send or schedule", () => {
    renderDemo("announcements");
    fireEvent.click(screen.getByRole("button", { name: "Class 8B" }));
    expect(screen.getByText("Reaches 26 people")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Now" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Sent to 26 people, each in their own language.",
    );
  });

  test("a sensitive record field is shown to staff as a mask", () => {
    renderDemo("records");
    expect(screen.getByText("Peanuts")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Sensitive"));
    expect(screen.queryByText("Peanuts")).toBeNull();
    expect(screen.getByText("Hidden until revealed; every reveal is logged.")).toBeTruthy();
  });

  test("imports keep an unknown column as a record field", () => {
    renderDemo("imports");
    fireEvent.click(screen.getByRole("button", { name: "Keep as a record field" }));
    expect(screen.getByRole("status").textContent).toBe("Kept as a record field");
  });

  test("an approval is written to the audit log", () => {
    renderDemo("oversight");
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(/Approved by the principal/)).toBeTruthy();
  });
});

describe("pricing: the school size", () => {
  test("any number of students costs the school nothing", async () => {
    const { container } = render(
      <main>
        <SchoolSize />
      </main>,
    );
    const slider = screen.getByLabelText("Students at your school");
    fireEvent.change(slider, { target: { value: "2400" } });
    expect(screen.getByText("2,400 students")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBe("2,400 students");
    // Intl puts a non-breaking space between the currency and the amount.
    expect(container.querySelector("output")?.textContent?.replace(/\s/g, " ")).toBe("JOD 0");
    await expectNoA11yViolations(container);
  });
});

describe("about: how a school starts", () => {
  test("steps are tabs: click or use the arrow keys", async () => {
    const { container } = render(
      <main>
        <StartSteps />
      </main>,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    expect(within(screen.getByRole("tabpanel")).getByText("Talk to us")).toBeTruthy();

    fireEvent.click(tabs[2]!);
    expect(within(screen.getByRole("tabpanel")).getByText("Bring in your lists")).toBeTruthy();
    expect(tabs[0]!.hasAttribute("data-done")).toBe(true);

    fireEvent.keyDown(screen.getAllByRole("tab")[2]!, { key: "End" });
    expect(screen.getAllByRole("tab")[4]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[4]!);
    await expectNoA11yViolations(container);
  });
});
