import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Tabs } from "./tabs";

const renderTabs = (props: Partial<Parameters<typeof Tabs>[0]> = {}) =>
  render(
    <Tabs defaultValue="lessons" {...props}>
      <Tabs.List aria-label="Course sections">
        <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
        <Tabs.Tab value="quizzes">Quizzes</Tabs.Tab>
        <Tabs.Tab value="grades">Grades</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="lessons">Lesson list</Tabs.Panel>
      <Tabs.Panel value="quizzes">Quiz list</Tabs.Panel>
      <Tabs.Panel value="grades">Grade list</Tabs.Panel>
    </Tabs>,
  );

const tab = (name: string) => screen.getByRole("tab", { name }) as HTMLButtonElement;

describe("Tabs", () => {
  test("renders a tablist and selects the default tab", () => {
    renderTabs();

    expect(screen.getByRole("tablist", { name: "Course sections" })).toBeDefined();
    expect(tab("Lessons").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Lesson list");
  });

  test("each tab controls a real panel that is labelled back by the tab", () => {
    renderTabs();
    const panel = screen.getByRole("tabpanel");

    expect(tab("Lessons").getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Lessons").id);
  });

  test("only the selected tab is in the page tab order", () => {
    renderTabs();

    expect(tab("Lessons").tabIndex).toBe(0);
    expect(tab("Quizzes").tabIndex).toBe(-1);
  });

  test("clicking a tab selects it and swaps the panel", () => {
    renderTabs();

    fireEvent.click(tab("Quizzes"));

    expect(tab("Quizzes").getAttribute("aria-selected")).toBe("true");
    expect(tab("Lessons").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel").textContent).toBe("Quiz list");
  });

  test("ArrowRight moves focus and selection to the next tab", () => {
    renderTabs();
    tab("Lessons").focus();

    fireEvent.keyDown(tab("Lessons"), { key: "ArrowRight" });

    expect(document.activeElement).toBe(tab("Quizzes"));
    expect(tab("Quizzes").getAttribute("aria-selected")).toBe("true");
  });

  test("ArrowLeft wraps from the first tab to the last", () => {
    renderTabs();
    tab("Lessons").focus();

    fireEvent.keyDown(tab("Lessons"), { key: "ArrowLeft" });

    expect(document.activeElement).toBe(tab("Grades"));
  });

  test("Home and End jump to the ends", () => {
    renderTabs({ defaultValue: "quizzes" });
    tab("Quizzes").focus();

    fireEvent.keyDown(tab("Quizzes"), { key: "End" });
    expect(document.activeElement).toBe(tab("Grades"));

    fireEvent.keyDown(tab("Grades"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Lessons"));
  });

  test("vertical orientation uses ArrowDown/ArrowUp", () => {
    renderTabs({ orientation: "vertical" });
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe("vertical");

    tab("Lessons").focus();
    fireEvent.keyDown(tab("Lessons"), { key: "ArrowDown" });

    expect(document.activeElement).toBe(tab("Quizzes"));
  });

  test("arrow navigation skips a disabled tab", () => {
    render(
      <Tabs defaultValue="lessons">
        <Tabs.List aria-label="Sections">
          <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
          <Tabs.Tab value="quizzes" disabled>
            Quizzes
          </Tabs.Tab>
          <Tabs.Tab value="grades">Grades</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="lessons">Lesson list</Tabs.Panel>
        <Tabs.Panel value="quizzes">Quiz list</Tabs.Panel>
        <Tabs.Panel value="grades">Grade list</Tabs.Panel>
      </Tabs>,
    );

    tab("Lessons").focus();
    fireEvent.keyDown(tab("Lessons"), { key: "ArrowRight" });

    expect(document.activeElement).toBe(tab("Grades"));
  });

  test("a disabled tab cannot be selected by clicking", () => {
    render(
      <Tabs defaultValue="lessons">
        <Tabs.List aria-label="Sections">
          <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
          <Tabs.Tab value="quizzes" disabled>
            Quizzes
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="lessons">Lesson list</Tabs.Panel>
        <Tabs.Panel value="quizzes">Quiz list</Tabs.Panel>
      </Tabs>,
    );

    fireEvent.click(tab("Quizzes"));

    expect(tab("Lessons").getAttribute("aria-selected")).toBe("true");
  });

  test("uncontrolled: owns its selection", () => {
    renderTabs();

    fireEvent.click(tab("Grades"));

    expect(tab("Grades").getAttribute("aria-selected")).toBe("true");
  });

  test("controlled: reports changes and follows the owner", () => {
    const onChange = mock();

    function Controlled() {
      const [value, setValue] = useState("lessons");
      return (
        <Tabs
          defaultValue="lessons"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        >
          <Tabs.List aria-label="Sections">
            <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
            <Tabs.Tab value="quizzes">Quizzes</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="lessons">Lesson list</Tabs.Panel>
          <Tabs.Panel value="quizzes">Quiz list</Tabs.Panel>
        </Tabs>
      );
    }

    render(<Controlled />);
    fireEvent.click(tab("Quizzes"));

    expect(onChange).toHaveBeenCalledWith("quizzes");
    expect(screen.getByRole("tabpanel").textContent).toBe("Quiz list");
  });

  test("controlled: a selection the owner refuses stays put", () => {
    renderTabs({ value: "lessons", onChange: () => undefined });

    fireEvent.click(tab("Quizzes"));

    expect(tab("Lessons").getAttribute("aria-selected")).toBe("true");
  });

  test("a Tab outside Tabs fails loudly", () => {
    expect(() => render(<Tabs.Tab value="x">X</Tabs.Tab>)).toThrow(/must be rendered inside/);
  });

  test("has no accessibility violations", async () => {
    const { container } = renderTabs();

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations with a disabled tab", async () => {
    const { container } = render(
      <Tabs defaultValue="lessons">
        <Tabs.List aria-label="Sections">
          <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
          <Tabs.Tab value="quizzes" disabled>
            Quizzes
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="lessons">Lesson list</Tabs.Panel>
        <Tabs.Panel value="quizzes">Quiz list</Tabs.Panel>
      </Tabs>,
    );

    await expectNoA11yViolations(container);
  });
});
