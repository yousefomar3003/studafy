import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import ErrorPage from "./ErrorPage";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth/error" element={<ErrorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

/**
 * Every documented auth error code the web OAuth flow can land on must render a distinct, actionable
 * state. The list is keyed on the API's stable problem codes — the same codes the OAuth callbacks
 * forward via `?code=` (`oauth/error-redirect.ts`).
 */
const RENDERED_STATES: readonly {
  code: string;
  heading: RegExp;
  actionLabel?: RegExp;
  actionHref?: string;
}[] = [
  { code: "OAUTH_STATE_INVALID", heading: /sign-in link has expired/i, actionLabel: /try again/i },
  { code: "AUTHZ_FORBIDDEN", heading: /no account found/i, actionLabel: /back to sign in/i },
  { code: "NO_ACCOUNT", heading: /no account found/i, actionLabel: /back to sign in/i },
  {
    code: "OAUTH_EMAIL_NOT_VERIFIED",
    heading: /email isn't verified/i,
    actionLabel: /try again/i,
  },
  {
    code: "OAUTH_PROVIDER_ERROR",
    heading: /couldn't complete your sign-in/i,
    actionLabel: /try again/i,
  },
  { code: "SCHOOL_SUSPENDED", heading: /account is suspended/i },
  { code: "TENANT_SUSPENDED", heading: /account is suspended/i },
  { code: "OAUTH_CANCELLED", heading: /sign-in cancelled/i, actionLabel: /try again/i },
];

describe("ErrorPage", () => {
  for (const state of RENDERED_STATES) {
    test(`renders guidance for ${state.code}`, () => {
      renderAt(`/auth/error?code=${state.code}`);

      expect(screen.getByRole("heading", { name: state.heading, level: 1 })).toBeTruthy();
      expect(screen.getByRole("alert")).toBeTruthy();

      const action = screen.queryByRole("link");
      if (state.actionLabel) {
        expect(action?.textContent).toMatch(state.actionLabel);
        expect(action?.getAttribute("href")).toBe("/auth/login");
      } else {
        // Retrying cannot fix a suspended school or a missing account, so these states must not
        // dangle a dead retry link.
        expect(action).toBeNull();
      }
    });
  }

  test("an unknown code falls back to the generic failure state", () => {
    renderAt("/auth/error?code=NOT_A_REAL_CODE");
    expect(screen.getByRole("heading", { name: /couldn't complete your sign-in/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /try again/i }).getAttribute("href")).toBe(
      "/auth/login",
    );
  });

  test("a direct visit with no code renders the generic failure state", () => {
    renderAt("/auth/error");
    expect(screen.getByRole("heading", { name: /couldn't complete your sign-in/i })).toBeTruthy();
  });
});
