import { cleanup, render } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { ShortcutLabel } from "./SummaryStrip";

/**
 * Every dashboard shortcut shows one forward arrow, glued to its last word, whether or not its
 * translation already carried one.
 */
describe("ShortcutLabel", () => {
  afterEach(cleanup);

  const tailOf = (label: string) => {
    const { container } = render(<ShortcutLabel label={label} />);
    return {
      text: container.textContent,
      tail: container.querySelector(".home-shortcuts__tail")?.textContent,
      arrows: container.querySelectorAll(".home-shortcuts__arrow").length,
    };
  };

  test("adds the arrow to a label without one", () => {
    expect(tailOf("Missing information")).toEqual({
      text: "Missing information →",
      tail: "information →",
      arrows: 1,
    });
  });

  test("replaces an arrow the translation carried, in either direction", () => {
    expect(tailOf("Classes and class records →")).toEqual({
      text: "Classes and class records →",
      tail: "records →",
      arrows: 1,
    });
    expect(tailOf("الشعب وسجلاتها ←").tail).toBe("وسجلاتها →");
  });

  test("a one-word label keeps its word with the arrow", () => {
    expect(tailOf("Parents")).toEqual({ text: "Parents →", tail: "Parents →", arrows: 1 });
  });

  test("the arrow is hidden from screen readers", () => {
    const { container } = render(<ShortcutLabel label="Parents" />);
    expect(container.querySelector(".home-shortcuts__arrow")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
