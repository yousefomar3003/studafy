import { ApiError } from "@studafy/api-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

import type { ComponentType } from "react";

/** Where the emailed school verification link lands. `../../lib/api` is stubbed. */

const TOKEN = "a".repeat(64);

const VERIFIED = {
  state: "verified",
  school: { id: "00000000-0000-4000-8000-000000000001", slug: "hill", name: "Hill School" },
};

const getMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: VERIFIED }),
);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { message: "sent" } }),
);
mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./VerifyEmailPage")).default;

function CurrentUrl() {
  const { pathname, hash } = useLocation();
  return <span data-testid="url">{`${pathname}${hash}`}</span>;
}

async function renderAt(url: string) {
  const Page = await loadPage();
  render(
    <MemoryRouter initialEntries={[url]}>
      <Page />
      <CurrentUrl />
    </MemoryRouter>,
  );
}

function apiError(status: number, code: string) {
  return new ApiError({
    status,
    title: "Error",
    code: code as never,
    detail: "Server detail",
    instance: null,
    type: null,
    request_id: "req-1",
    problem: null,
  });
}

const verifyButton = () => screen.getByRole("button", { name: /verify my email/i });

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("VerifyEmailPage", () => {
  test("verifies nothing until the button is pressed, and drops the token from the URL", async () => {
    await renderAt(`/verify-email#token=${TOKEN}`);

    expect(verifyButton()).toBeTruthy();
    expect(getMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("url").textContent).toBe("/verify-email");
  });

  test("pressing the button verifies and offers sign-in", async () => {
    await renderAt(`/verify-email#token=${TOKEN}`);

    fireEvent.click(verifyButton());

    await screen.findByRole("heading", { name: /your school is active/i });
    expect(getMock).toHaveBeenCalledWith("/api/schools/verify-email/{token}", {
      params: { path: { token: TOKEN } },
    });
    expect(screen.getByRole("status").textContent).toContain("Hill School");
    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/auth/login");
  });

  test("an expired link offers a new one", async () => {
    getMock.mockImplementationOnce(() =>
      Promise.reject(apiError(409, "VERIFICATION_TOKEN_EXPIRED")),
    );
    await renderAt(`/verify-email#token=${TOKEN}`);

    fireEvent.click(verifyButton());

    expect((await screen.findByRole("alert")).textContent).toContain("expired");
    expect(screen.queryByRole("button", { name: /verify my email/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/school contact email/i), {
      target: { value: "office@hill.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send a new link/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/api/schools/resend-verification", {
        body: { email: "office@hill.example" },
      });
    });
    expect((await screen.findByRole("status")).textContent).toContain("office@hill.example");
  });

  test("an invalid or used link offers both sign-in and a new link", async () => {
    getMock.mockImplementationOnce(() =>
      Promise.reject(apiError(400, "VERIFICATION_TOKEN_INVALID")),
    );
    await renderAt(`/verify-email#token=${TOKEN}`);

    fireEvent.click(verifyButton());

    expect((await screen.findByRole("alert")).textContent).toContain("already been used");
    expect(screen.getByRole("link", { name: /sign in/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /send a new link/i })).toBeTruthy();
  });

  test("an already-verified school is pointed at sign-in", async () => {
    getMock.mockImplementationOnce(() =>
      Promise.reject(apiError(409, "VERIFICATION_TOKEN_CONSUMED")),
    );
    await renderAt(`/verify-email#token=${TOKEN}`);

    fireEvent.click(verifyButton());

    expect((await screen.findByRole("alert")).textContent).toContain("already verified");
    expect(screen.getByRole("link", { name: /sign in/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send a new link/i })).toBeNull();
  });

  test("a rate-limited attempt can be retried", async () => {
    getMock.mockImplementationOnce(() => Promise.reject(apiError(429, "RATE_LIMIT_EXCEEDED")));
    await renderAt(`/verify-email#token=${TOKEN}`);

    fireEvent.click(verifyButton());

    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");
    fireEvent.click(verifyButton());
    await screen.findByRole("heading", { name: /your school is active/i });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  test("a link without a token offers a new one and no verify button", async () => {
    await renderAt("/verify-email");

    expect(screen.getByRole("alert").textContent).toContain("incomplete");
    expect(screen.queryByRole("button", { name: /verify my email/i })).toBeNull();
    expect(screen.getByRole("button", { name: /send a new link/i })).toBeTruthy();
  });
});
