import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Input } from "./input";

describe("Input", () => {
  test("associates the label with the control", () => {
    render(<Input label="Email" />);

    expect(screen.getByLabelText("Email")).toBeInstanceOf(HTMLInputElement);
  });

  test("renders a placeholder", () => {
    render(<Input label="Email" placeholder="you@studafy.com" />);

    expect(screen.getByPlaceholderText("you@studafy.com")).toBeDefined();
  });

  test("describes the control with helper text", () => {
    render(<Input label="Email" helperText="We never share it." />);
    const input = screen.getByLabelText("Email");
    const helperId = input.getAttribute("aria-describedby");

    expect(helperId).toBeTruthy();
    expect(document.getElementById(helperId as string)?.textContent).toBe("We never share it.");
  });

  test("error sets aria-invalid, announces via role=alert, and is referenced", () => {
    render(<Input label="Email" error="Enter a valid email." />);
    const input = screen.getByLabelText("Email");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a valid email.");
    expect(input.getAttribute("aria-describedby")).toContain("-error");
  });

  test("references both helper and error when each is present", () => {
    render(<Input label="Email" helperText="Work address." error="Required." />);
    const describedBy = screen.getByLabelText("Email").getAttribute("aria-describedby") ?? "";

    expect(describedBy.split(" ")).toHaveLength(2);
  });

  test("does not emit aria-describedby when there is nothing to describe", () => {
    render(<Input label="Email" />);

    expect(screen.getByLabelText("Email").hasAttribute("aria-describedby")).toBe(false);
  });

  test("marks the control required without the asterisk leaking into its accessible name", () => {
    render(<Input label="Email" required />);
    // getByRole computes the accessible name properly, so it ignores the aria-hidden asterisk.
    const input = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement;

    expect(input.required).toBe(true);
  });

  test("disabled blocks input", () => {
    render(<Input label="Email" disabled />);

    expect((screen.getByLabelText("Email") as HTMLInputElement).disabled).toBe(true);
  });

  test("renders prefix and suffix without polluting the accessible name", () => {
    render(<Input label="Amount" prefix="$" suffix="USD" />);

    expect(screen.getByLabelText("Amount")).toBeDefined();
    expect(screen.getByText("$").getAttribute("aria-hidden")).toBe("true");
  });

  test("works uncontrolled via defaultValue", () => {
    render(<Input label="Email" defaultValue="a@b.com" />);
    const input = screen.getByLabelText("Email") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "c@d.com" } });

    expect(input.value).toBe("c@d.com");
  });

  test("works controlled: value only changes when the owner updates it", () => {
    const onChange = mock();

    function Controlled() {
      const [value, setValue] = useState("start");
      return (
        <Input
          label="Email"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setValue(event.target.value);
          }}
        />
      );
    }

    render(<Controlled />);
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    expect(input.value).toBe("start");

    fireEvent.change(input, { target: { value: "next" } });

    expect(onChange).toHaveBeenCalledWith("next");
    expect(input.value).toBe("next");
  });

  test("a controlled value the owner refuses to change stays put", () => {
    render(<Input label="Email" value="frozen" onChange={() => undefined} />);
    const input = screen.getByLabelText("Email") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "attempted" } });

    expect(input.value).toBe("frozen");
  });

  test("forwards its ref to the underlying input", () => {
    let node: HTMLInputElement | null = null;
    render(<Input label="Email" ref={(element) => (node = element)} />);

    expect(node).toBeInstanceOf(HTMLInputElement);
  });

  test("has no accessibility violations", async () => {
    const { container } = render(
      <main>
        <Input label="Email" helperText="Work address." required />
        <Input label="Password" error="Too short." />
        <Input label="Disabled" disabled />
      </main>,
    );

    await expectNoA11yViolations(container);
  });
});
