import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Select } from "./select";

import type { SelectOption } from "./select";

const options: SelectOption[] = [
  { value: "easy", label: "Easy" },
  { value: "medium", label: "Medium", disabled: true },
  { value: "hard", label: "Hard" },
];

const renderSelect = (props: Partial<Parameters<typeof Select>[0]> = {}) =>
  render(<Select label="Difficulty" options={options} {...props} />);

const trigger = () => screen.getByRole("combobox") as HTMLButtonElement;
const listbox = () => screen.getByRole("listbox", { hidden: true });
/** The listbox stays mounted (hidden) so aria-controls resolves, so assert on the trigger's text. */
const triggerText = () => trigger().textContent;

describe("Select", () => {
  test("renders a labelled, collapsed combobox showing the placeholder", () => {
    renderSelect({ placeholder: "Choose one" });

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(screen.getByText("Choose one")).toBeDefined();
  });

  test("the trigger controls a real listbox", () => {
    renderSelect();

    expect(trigger().getAttribute("aria-controls")).toBe(listbox().id);
  });

  test("clicking the trigger opens the listbox", () => {
    renderSelect();

    fireEvent.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  test("clicking an option selects it and closes the listbox", () => {
    renderSelect();
    fireEvent.click(trigger());

    fireEvent.click(screen.getByRole("option", { name: "Hard" }));

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(triggerText()).toContain("Hard");
  });

  test("a disabled option cannot be selected", () => {
    const onChange = mock();
    renderSelect({ onChange });
    fireEvent.click(trigger());

    fireEvent.click(screen.getByRole("option", { name: "Medium" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("ArrowDown opens the listbox when closed", () => {
    renderSelect();
    trigger().focus();

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("aria-activedescendant tracks the active option and skips disabled ones", () => {
    renderSelect();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });

    const optionIds = screen.getAllByRole("option").map((option) => option.id);
    expect(trigger().getAttribute("aria-activedescendant")).toBe(optionIds[0]);

    // Medium is disabled, so ArrowDown must land on Hard.
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger().getAttribute("aria-activedescendant")).toBe(optionIds[2]);
  });

  test("Enter selects the active option", () => {
    const onChange = mock();
    renderSelect({ onChange });

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("hard");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  test("Home and End move to the first and last enabled options", () => {
    renderSelect();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const optionIds = screen.getAllByRole("option").map((option) => option.id);

    fireEvent.keyDown(trigger(), { key: "End" });
    expect(trigger().getAttribute("aria-activedescendant")).toBe(optionIds[2]);

    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(trigger().getAttribute("aria-activedescendant")).toBe(optionIds[0]);
  });

  test("Escape closes the listbox and returns focus to the trigger", () => {
    renderSelect();
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });

    fireEvent.keyDown(trigger(), { key: "Escape" });

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  test("Tab closes the listbox without selecting", () => {
    const onChange = mock();
    renderSelect({ onChange });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });

    fireEvent.keyDown(trigger(), { key: "Tab" });

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("typeahead jumps to the matching option", () => {
    renderSelect();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const optionIds = screen.getAllByRole("option").map((option) => option.id);

    fireEvent.keyDown(trigger(), { key: "h" });

    expect(trigger().getAttribute("aria-activedescendant")).toBe(optionIds[2]);
  });

  test("uncontrolled: honours defaultValue and owns its selection", () => {
    renderSelect({ defaultValue: "easy" });
    expect(triggerText()).toContain("Easy");

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "Hard" }));

    expect(triggerText()).toContain("Hard");
  });

  test("controlled: follows the owner and reports changes", () => {
    const onChange = mock();

    function Controlled() {
      const [value, setValue] = useState("easy");
      return (
        <Select
          label="Difficulty"
          options={options}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<Controlled />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "Hard" }));

    expect(onChange).toHaveBeenCalledWith("hard");
    expect(triggerText()).toContain("Hard");
  });

  test("controlled: a value the owner refuses to change stays put", () => {
    renderSelect({ value: "easy", onChange: () => undefined });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "Hard" }));

    expect(triggerText()).toContain("Easy");
  });

  test("disabled cannot be opened", () => {
    renderSelect({ disabled: true });

    fireEvent.click(trigger());

    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  test("error marks the trigger invalid and announces the message", () => {
    renderSelect({ error: "Choose a difficulty." });

    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Choose a difficulty.");
    expect(trigger().getAttribute("aria-describedby")).toContain("-error");
  });

  test("helper text describes the trigger", () => {
    renderSelect({ helperText: "You can change this later." });

    expect(trigger().getAttribute("aria-describedby")).toContain("-helper");
  });

  test("name renders a hidden input carrying the value for form submission", () => {
    const { container } = renderSelect({ name: "difficulty", defaultValue: "hard" });
    const hidden = container.querySelector('input[type="hidden"]') as HTMLInputElement;

    expect(hidden.name).toBe("difficulty");
    expect(hidden.value).toBe("hard");
  });

  test("has no accessibility violations when closed", async () => {
    const { container } = render(
      <main>
        <Select label="Difficulty" options={options} helperText="Pick one." />
      </main>,
    );

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations when open", async () => {
    const { container } = render(
      <main>
        <Select label="Difficulty" options={options} />
      </main>,
    );
    fireEvent.click(trigger());

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations in the error state", async () => {
    const { container } = render(
      <main>
        <Select label="Difficulty" options={options} error="Required." required />
      </main>,
    );

    await expectNoA11yViolations(container);
  });
});
