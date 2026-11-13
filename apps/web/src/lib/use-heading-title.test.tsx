import { act, cleanup, render } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { useRef, useState } from "react";

import { documentTitleFor, headingTitle, useHeadingTitle } from "./use-heading-title";

afterEach(cleanup);

describe("headingTitle", () => {
  test("reads the first h1 and drops aria-hidden decorations", () => {
    const root = document.createElement("div");
    const heading = document.createElement("h1");
    heading.append("Grade  10\n");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✓";
    heading.append(icon);
    const second = document.createElement("h1");
    second.textContent = "Second";
    const sub = document.createElement("h2");
    sub.textContent = "Not this";
    root.append(heading, second, sub);
    expect(headingTitle(root)).toBe("Grade 10");
  });

  test("is empty without an h1", () => {
    expect(headingTitle(document.createElement("div"))).toBe("");
  });
});

describe("documentTitleFor", () => {
  test("names the page, then the product", () => {
    expect(documentTitleFor("Approvals")).toBe("Approvals | Studafy");
    expect(documentTitleFor("")).toBe("Studafy");
  });
});

describe("useHeadingTitle", () => {
  let setHeading: (heading: string | null) => void = () => undefined;
  function Shell() {
    const ref = useRef<HTMLDivElement>(null);
    const [heading, set] = useState<string | null>("Approvals");
    setHeading = set;
    useHeadingTitle(ref);
    return <div ref={ref}>{heading === null ? <p>Loading</p> : <h1>{heading}</h1>}</div>;
  }
  const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

  test("follows the heading as pages change and data arrives", async () => {
    const { unmount } = render(<Shell />);
    expect(document.title).toBe("Approvals | Studafy");

    act(() => setHeading(null));
    await nextFrame();
    expect(document.title).toBe("Studafy");

    act(() => setHeading("Ahmad Ali"));
    await nextFrame();
    expect(document.title).toBe("Ahmad Ali | Studafy");

    unmount();
    expect(document.title).toBe("Studafy");
  });
});
