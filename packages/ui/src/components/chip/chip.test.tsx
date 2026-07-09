import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Chip } from "./chip";

describe("Chip", () => {
  test("renders its label", () => {
    render(<Chip>Algebra</Chip>);

    expect(screen.getByText("Algebra")).toBeDefined();
  });

  test.each([["filled"], ["outlined"]] as const)("applies the %s variant class", (variant) => {
    const { container } = render(<Chip variant={variant}>Algebra</Chip>);

    expect(container.querySelector(".sf-chip")?.className).toContain(`sf-chip--${variant}`);
  });

  test("is not interactive without onRemove", () => {
    render(<Chip>Algebra</Chip>);

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("removable renders exactly one focusable control, naming the chip it removes", () => {
    render(<Chip onRemove={() => undefined}>Algebra</Chip>);

    expect(screen.getByRole("button", { name: "Remove Algebra" })).toBeDefined();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("removeLabel overrides the generated accessible name", () => {
    render(
      <Chip onRemove={() => undefined} removeLabel="Remove the algebra topic">
        Algebra
      </Chip>,
    );

    expect(screen.getByRole("button", { name: "Remove the algebra topic" })).toBeDefined();
  });

  test("calls onRemove when the remove button is activated", () => {
    const onRemove = mock();
    render(<Chip onRemove={onRemove}>Algebra</Chip>);

    fireEvent.click(screen.getByRole("button"));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  test("disabled prevents removal", () => {
    const onRemove = mock();
    render(
      <Chip disabled onRemove={onRemove}>
        Algebra
      </Chip>,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onRemove).not.toHaveBeenCalled();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("the remove button is focusable", () => {
    render(<Chip onRemove={() => undefined}>Algebra</Chip>);
    const button = screen.getByRole("button");
    button.focus();

    expect(document.activeElement).toBe(button);
  });

  test("forwards its ref to the chip element", () => {
    let node: HTMLSpanElement | null = null;
    render(<Chip ref={(element) => (node = element)}>Algebra</Chip>);

    expect(node).toBeInstanceOf(HTMLSpanElement);
  });

  test("has no accessibility violations", async () => {
    const { container } = render(
      <main>
        <Chip>Static</Chip>
        <Chip variant="outlined">Outlined</Chip>
        <Chip onRemove={() => undefined}>Removable</Chip>
        <Chip disabled onRemove={() => undefined}>
          Disabled
        </Chip>
      </main>,
    );

    await expectNoA11yViolations(container);
  });
});
