import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { routes } from "./routes";

afterEach(cleanup);

const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
};

describe("app shell", () => {
  test("renders the shared shell and marketing home at /", async () => {
    renderAt("/");
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: /studafy/i, level: 1 })).toBeTruthy();
  });

  test("resolves the lazy /portal route group", async () => {
    renderAt("/portal");
    expect(await screen.findByRole("heading", { name: /portal/i, level: 1 })).toBeTruthy();
  });

  test("resolves the lazy /account route group", async () => {
    renderAt("/account");
    expect(await screen.findByRole("heading", { name: /account/i, level: 1 })).toBeTruthy();
  });
});
