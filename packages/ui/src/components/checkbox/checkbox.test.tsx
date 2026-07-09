import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Checkbox } from "./checkbox";

const checkbox = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("Checkbox", () => {
  test("associates the label with the control", () => {
    render(<Checkbox label="Remember me" />);

    expect(screen.getByLabelText("Remember me")).toBeInstanceOf(HTMLInputElement);
  });

  test("is unchecked by default and toggles on click", () => {
    render(<Checkbox label="Remember me" />);
    expect(checkbox().checked).toBe(false);

    fireEvent.click(checkbox());

    expect(checkbox().checked).toBe(true);
  });

  test("honours defaultChecked when uncontrolled", () => {
    render(<Checkbox label="Remember me" defaultChecked />);

    expect(checkbox().checked).toBe(true);
  });

  test("controlled: stays put unless the owner updates it", () => {
    render(<Checkbox label="Remember me" checked={false} onChange={() => undefined} />);

    fireEvent.click(checkbox());

    expect(checkbox().checked).toBe(false);
  });

  test("controlled: follows the owner's state", () => {
    function Controlled() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          label="Remember me"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
      );
    }
    render(<Controlled />);

    fireEvent.click(checkbox());

    expect(checkbox().checked).toBe(true);
  });

  test("indeterminate is set as a DOM property, not an attribute", () => {
    render(<Checkbox label="Select all" indeterminate />);

    // The mixed state has no HTML attribute; asserting the attribute would silently pass forever.
    expect(checkbox().indeterminate).toBe(true);
    expect(checkbox().hasAttribute("indeterminate")).toBe(false);
  });

  test("clears indeterminate when the prop flips back", () => {
    const { rerender } = render(<Checkbox label="Select all" indeterminate />);
    expect(checkbox().indeterminate).toBe(true);

    rerender(<Checkbox label="Select all" indeterminate={false} />);

    expect(checkbox().indeterminate).toBe(false);
  });

  test("disabled blocks toggling", () => {
    const onChange = mock();
    render(<Checkbox label="Remember me" disabled onChange={onChange} />);

    fireEvent.click(checkbox());

    expect(checkbox().checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("error sets aria-invalid and announces the message", () => {
    render(<Checkbox label="Accept terms" error="You must accept the terms." />);

    expect(checkbox().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("You must accept the terms.");
    expect(checkbox().getAttribute("aria-describedby")).toContain("-error");
  });

  test("is focusable", () => {
    render(<Checkbox label="Remember me" />);
    checkbox().focus();

    expect(document.activeElement).toBe(checkbox());
  });

  test("forwards its ref while still driving indeterminate", () => {
    let node: HTMLInputElement | null = null;
    render(<Checkbox label="Select all" indeterminate ref={(element) => (node = element)} />);

    expect(node).toBeInstanceOf(HTMLInputElement);
    expect((node as unknown as HTMLInputElement).indeterminate).toBe(true);
  });

  test("has no accessibility violations", async () => {
    const { container } = render(
      <main>
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Mixed" indeterminate />
        <Checkbox label="Disabled" disabled />
        <Checkbox label="Invalid" error="Required." />
      </main>,
    );

    await expectNoA11yViolations(container);
  });
});
