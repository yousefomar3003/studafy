import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Radio } from "./radio";
import { RadioGroup } from "./radio-group";

const renderGroup = (props: Partial<Parameters<typeof RadioGroup>[0]> = {}) =>
  render(
    <RadioGroup label="Difficulty" name="difficulty" {...props}>
      <Radio value="easy" label="Easy" />
      <Radio value="medium" label="Medium" />
      <Radio value="hard" label="Hard" />
    </RadioGroup>,
  );

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("RadioGroup", () => {
  test("exposes a labelled radiogroup containing its radios", () => {
    renderGroup();

    expect(screen.getByRole("group", { name: "Difficulty" })).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  test("radios share the group name, which is what enables native arrow-key navigation", () => {
    renderGroup();

    expect(radio("Easy").name).toBe("difficulty");
    expect(radio("Medium").name).toBe("difficulty");
  });

  test("uncontrolled: selects on click and deselects the sibling", () => {
    renderGroup({ defaultValue: "easy" });
    expect(radio("Easy").checked).toBe(true);

    fireEvent.click(radio("Hard"));

    expect(radio("Hard").checked).toBe(true);
    expect(radio("Easy").checked).toBe(false);
  });

  test("controlled: reports the change and follows the owner", () => {
    const onChange = mock();

    function Controlled() {
      const [value, setValue] = useState("easy");
      return (
        <RadioGroup
          label="Difficulty"
          name="difficulty"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        >
          <Radio value="easy" label="Easy" />
          <Radio value="hard" label="Hard" />
        </RadioGroup>
      );
    }

    render(<Controlled />);
    fireEvent.click(radio("Hard"));

    expect(onChange).toHaveBeenCalledWith("hard");
    expect(radio("Hard").checked).toBe(true);
  });

  test("controlled: a value the owner refuses to change stays put", () => {
    renderGroup({ value: "easy", onChange: () => undefined });

    fireEvent.click(radio("Hard"));

    expect(radio("Easy").checked).toBe(true);
    expect(radio("Hard").checked).toBe(false);
  });

  test("a disabled group disables every radio", () => {
    renderGroup({ disabled: true });

    expect(radio("Easy").disabled).toBe(true);
    expect(radio("Hard").disabled).toBe(true);
  });

  test("an individual radio can be disabled", () => {
    render(
      <RadioGroup label="Difficulty" name="difficulty">
        <Radio value="easy" label="Easy" />
        <Radio value="hard" label="Hard" disabled />
      </RadioGroup>,
    );

    expect(radio("Easy").disabled).toBe(false);
    expect(radio("Hard").disabled).toBe(true);
  });

  test("a disabled radio does not select on click", () => {
    const onChange = mock();
    render(
      <RadioGroup label="Difficulty" name="difficulty" onChange={onChange}>
        <Radio value="hard" label="Hard" disabled />
      </RadioGroup>,
    );

    fireEvent.click(radio("Hard"));

    expect(onChange).not.toHaveBeenCalled();
    expect(radio("Hard").checked).toBe(false);
  });

  test("radios are focusable", () => {
    renderGroup();
    radio("Medium").focus();

    expect(document.activeElement).toBe(radio("Medium"));
  });

  test("error announces the message and marks the group invalid", () => {
    renderGroup({ error: "Choose a difficulty." });

    expect(screen.getByRole("alert").textContent).toBe("Choose a difficulty.");
    expect(screen.getByRole("group").getAttribute("aria-invalid")).toBe("true");
  });

  test("a Radio outside a RadioGroup fails loudly", () => {
    expect(() => render(<Radio value="x" label="X" />)).toThrow(/must be rendered inside/);
  });

  test("has no accessibility violations", async () => {
    const { container } = renderGroup({ defaultValue: "easy" });

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations in the error state", async () => {
    const { container } = renderGroup({ error: "Choose a difficulty." });

    await expectNoA11yViolations(container);
  });
});
