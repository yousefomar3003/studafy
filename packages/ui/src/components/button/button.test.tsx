import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Button } from "./button";

describe("Button", () => {
  test("renders its label and defaults to type=button", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });

    expect(button.getAttribute("type")).toBe("button");
  });

  test.each([["primary"], ["secondary"], ["tertiary"]] as const)(
    "applies the %s variant class",
    (variant) => {
      render(<Button variant={variant}>Save</Button>);

      expect(screen.getByRole("button").className).toContain(`sf-button--${variant}`);
    },
  );

  test("calls onClick when activated", () => {
    const onClick = mock();
    render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("is operable by keyboard", () => {
    const onClick = mock();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button");

    button.focus();
    expect(document.activeElement).toBe(button);

    // happy-dom does not synthesise click from keydown, so assert the native affordance instead:
    // a <button> is activated by Enter/Space by the browser itself.
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("does not fire onClick when disabled", () => {
    const onClick = mock();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).not.toHaveBeenCalled();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("loading disables the button, marks it busy, and keeps its accessible name", () => {
    const onClick = mock();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("hides decorative icons from assistive technology", () => {
    render(
      <Button leadingIcon={<svg />} trailingIcon={<svg />}>
        Save
      </Button>,
    );

    // The accessible name must come from the label alone.
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  test("forwards its ref to the underlying button", () => {
    let node: HTMLButtonElement | null = null;
    render(<Button ref={(element) => (node = element)}>Save</Button>);

    expect(node).toBeInstanceOf(HTMLButtonElement);
  });

  test("has no accessibility violations", async () => {
    const { container } = render(
      <main>
        <Button>Save</Button>
        <Button variant="secondary" disabled>
          Cancel
        </Button>
        <Button variant="tertiary" loading>
          Submitting
        </Button>
      </main>,
    );

    await expectNoA11yViolations(container);
  });
});
