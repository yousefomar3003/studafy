import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { HomeShortcutGroups } from "./SummaryStrip";

import type { ShortcutGroup } from "./SummaryStrip";

afterEach(cleanup);

const GROUPS: ShortcutGroup[] = [
  {
    key: "people",
    label: "People",
    links: [
      { key: "users", to: "/users", label: "Manage users →" },
      { key: "students", to: "/students", label: "Manage students →" },
    ],
  },
  // Every link filtered out by permission: the group must not appear as an empty menu.
  { key: "empty", label: "Nothing here", links: [] },
];

function renderGroups(groups: readonly ShortcutGroup[]) {
  return render(
    <MemoryRouter>
      <HomeShortcutGroups groups={groups} />
    </MemoryRouter>,
  );
}

describe("HomeShortcutGroups", () => {
  test("hides a group that has no links left", () => {
    renderGroups(GROUPS);

    expect(screen.getByRole("button", { name: /People/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Nothing here/ })).toBeNull();
  });

  test("renders nothing at all when no group has a link", () => {
    const { container } = renderGroups([{ key: "empty", label: "Nothing here", links: [] }]);

    expect(container.querySelector("nav")).toBeNull();
  });

  test("lists a group's links without the arrow their labels carry, and closes on a pick", () => {
    renderGroups(GROUPS);
    fireEvent.click(screen.getByRole("button", { name: /People/ }));

    const users = screen.getByRole("link", { name: "Manage users" });
    expect(users.textContent).toBe("Manage users");
    fireEvent.click(users);
    expect(screen.queryByRole("link", { name: "Manage students" })).toBeNull();
  });
});
