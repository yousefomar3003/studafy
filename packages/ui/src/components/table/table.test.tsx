import { render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Table } from "./table";

import type { ReactNode } from "react";

const rows = [
  { id: 1, topic: "Algebra", score: "92%" },
  { id: 2, topic: "Geometry", score: "78%" },
];

const renderTable = (bodyProps: { loading?: boolean; empty?: ReactNode } = {}, data = rows) =>
  render(
    <Table caption="Quiz results">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Topic</Table.HeaderCell>
          <Table.HeaderCell>Score</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body columnCount={2} {...bodyProps}>
        {data.map((row) => (
          <Table.Row key={row.id}>
            <Table.Cell>{row.topic}</Table.Cell>
            <Table.Cell>{row.score}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>,
  );

describe("Table", () => {
  test("renders real table semantics with a caption", () => {
    renderTable();

    expect(screen.getByRole("table", { name: "Quiz results" })).toBeDefined();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  test("column headers carry a scope", () => {
    renderTable();

    expect(screen.getByRole("columnheader", { name: "Topic" }).getAttribute("scope")).toBe("col");
  });

  test("renders the body rows", () => {
    renderTable();

    expect(screen.getByText("Algebra")).toBeDefined();
    expect(screen.getByText("78%")).toBeDefined();
  });

  test("the scroll container is a labelled, keyboard-reachable region", () => {
    renderTable();
    const region = screen.getByRole("region", { name: "Quiz results" });

    expect(region.getAttribute("tabindex")).toBe("0");
  });

  test("loading marks the body busy and announces status", () => {
    const { container } = renderTable({ loading: true });

    expect(container.querySelector("tbody")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading");
    expect(screen.queryByText("Algebra")).toBeNull();
  });

  test("empty renders the fallback when there are no rows", () => {
    renderTable({ empty: "No quizzes yet." }, []);

    expect(screen.getByText("No quizzes yet.")).toBeDefined();
  });

  test("empty falls back to a default message", () => {
    renderTable({}, []);

    expect(screen.getByText("No results.")).toBeDefined();
  });

  test("loading takes precedence over empty", () => {
    renderTable({ loading: true, empty: "No quizzes yet." }, []);

    expect(screen.queryByText("No quizzes yet.")).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });

  test("a hidden caption still names the table", () => {
    render(
      <Table caption="Quiz results" hideCaption>
        <Table.Body columnCount={1}>{null}</Table.Body>
      </Table>,
    );

    expect(screen.getByRole("table", { name: "Quiz results" })).toBeDefined();
  });

  test("forwards its ref to the table element", () => {
    let node: HTMLTableElement | null = null;
    render(
      <Table caption="Quiz results" ref={(element) => (node = element)}>
        <Table.Body columnCount={1}>{null}</Table.Body>
      </Table>,
    );

    expect(node).toBeInstanceOf(HTMLTableElement);
  });

  test("has no accessibility violations", async () => {
    const { container } = renderTable();

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations while loading", async () => {
    const { container } = renderTable({ loading: true });

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations when empty", async () => {
    const { container } = renderTable({ empty: "No quizzes yet." }, []);

    await expectNoA11yViolations(container);
  });
});
