import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { createTestSessionStore } from "../test/session";

import { AuthProvider } from "./context";
import { RequireAuth } from "./require-auth";

afterEach(cleanup);

async function renderGuardedAs(roles: string[]) {
  const store = await createTestSessionStore(roles);
  render(
    <AuthProvider store={store}>
      <MemoryRouter initialEntries={["/portal"]}>
        <Routes>
          <Route
            path="/portal"
            element={
              <RequireAuth>
                <h1>Portal</h1>
              </RequireAuth>
            }
          />
          <Route path="/auth/error" element={<h1>Use the mobile app</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
  return store;
}

describe("RequireAuth", () => {
  test.each([["STUDENT"], ["PARENT"], ["INSTRUCTOR"], ["ATTENDANCE_OFFICER"]])(
    "signs a %s session out and points it at the mobile app",
    async (role) => {
      const store = await renderGuardedAs([role]);

      expect(await screen.findByRole("heading", { name: "Use the mobile app" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Portal" })).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.getRoles()).toEqual([]);
    },
  );

  test("lets a web role through, even when it also teaches", async () => {
    await renderGuardedAs(["INSTRUCTOR", "ORG_ADMIN"]);
    expect(await screen.findByRole("heading", { name: "Portal" })).toBeTruthy();
  });
});
