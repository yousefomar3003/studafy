import { render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Card } from "./card";

describe("Card", () => {
  test("renders header, body and footer content", () => {
    render(
      <Card>
        <Card.Header>Algebra</Card.Header>
        <Card.Body>12 lessons</Card.Body>
        <Card.Footer>Updated today</Card.Footer>
      </Card>,
    );

    expect(screen.getByText("Algebra")).toBeDefined();
    expect(screen.getByText("12 lessons")).toBeDefined();
    expect(screen.getByText("Updated today")).toBeDefined();
  });

  test("defaults to elevation 1 and honours an explicit level", () => {
    const { container, rerender } = render(<Card>Body</Card>);
    expect(container.querySelector(".sf-card")?.getAttribute("data-elevation")).toBe("1");

    rerender(<Card elevation={4}>Body</Card>);
    expect(container.querySelector(".sf-card")?.getAttribute("data-elevation")).toBe("4");
  });

  test("is a static container by default", () => {
    const { container } = render(<Card>Body</Card>);
    const card = container.querySelector(".sf-card");

    expect(card?.className).not.toContain("sf-card--interactive");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("interactive adds the affordance without making the card a control", () => {
    const { container } = render(<Card interactive>Body</Card>);
    const card = container.querySelector(".sf-card");

    expect(card?.className).toContain("sf-card--interactive");
    // The critical guarantee of the stretched-action pattern: no role, no tabindex on the card.
    expect(card?.getAttribute("role")).toBeNull();
    expect(card?.getAttribute("tabindex")).toBeNull();
  });

  test("an interactive card exposes exactly one tab stop, named by its action", () => {
    render(
      <Card interactive>
        <Card.Header>
          <h3>
            <a className="sf-card__action" href="/algebra">
              Algebra
            </a>
          </h3>
        </Card.Header>
        <Card.Body>12 lessons</Card.Body>
      </Card>,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveProperty("textContent", "Algebra");
  });

  test("renders as the requested element", () => {
    const { container } = render(<Card as="article">Body</Card>);

    expect(container.querySelector("article")).not.toBeNull();
  });

  test("forwards its ref", () => {
    let node: HTMLDivElement | null = null;
    render(<Card ref={(element) => (node = element)}>Body</Card>);

    expect(node).toBeInstanceOf(HTMLDivElement);
  });

  test("has no accessibility violations as a static card", async () => {
    const { container } = render(
      <main>
        <Card>
          <Card.Header>
            <h3>Algebra</h3>
          </Card.Header>
          <Card.Body>12 lessons</Card.Body>
          <Card.Footer>Updated today</Card.Footer>
        </Card>
      </main>,
    );

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations as an interactive card", async () => {
    const { container } = render(
      <main>
        <Card interactive>
          <Card.Header>
            <h3>
              <a className="sf-card__action" href="/algebra">
                Algebra
              </a>
            </h3>
          </Card.Header>
          <Card.Body>12 lessons</Card.Body>
        </Card>
      </main>,
    );

    await expectNoA11yViolations(container);
  });
});
