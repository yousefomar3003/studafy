import { ApiError } from "@studafy/api-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType, Ref } from "react";

/**
 * The public deletion request form (ST-302). `../../lib/api` and the Turnstile widget are stubbed,
 * as in routes/onboarding/OnboardingPage.test.tsx; the widget stub solves its challenge on mount.
 */

const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { message: "ok" } }),
);
mock.module("../../lib/api", () => ({ api: { POST: postMock } }));

const resetMock = mock(() => undefined);
mock.module("../../components/TurnstileWidget", () => ({
  TurnstileWidget: forwardRef(function MockTurnstileWidget(
    { onToken }: { onToken: (token: string) => void },
    ref: Ref<{ reset: () => void }>,
  ) {
    useImperativeHandle(ref, () => ({ reset: resetMock }));
    useEffect(() => {
      onToken("captcha-token");
    }, [onToken]);
    return null;
  }),
}));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./DeleteAccountInfoPage")).default;

async function renderPage() {
  const Page = await loadPage();
  render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
}

function submit(email: string) {
  fireEvent.change(screen.getByLabelText(/account email/i), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /email me a deletion link/i }));
}

afterEach(() => {
  cleanup();
  postMock.mockClear();
  resetMock.mockClear();
});

describe("DeleteAccountInfoPage", () => {
  test("links to signed-in deletion and the privacy policy", async () => {
    await renderPage();

    expect(screen.getByRole("link", { name: /delete account/i }).getAttribute("href")).toBe(
      "/account/delete",
    );
    expect(screen.getAllByRole("link", { name: /privacy policy/i })[0]!.getAttribute("href")).toBe(
      "/privacy",
    );
  });

  test("sends the email and captcha token, then says what to expect", async () => {
    await renderPage();

    submit(" parent@example.com ");

    await screen.findByRole("status");
    expect(postMock).toHaveBeenCalledWith("/api/account/deletion-requests", {
      body: { email: "parent@example.com", captcha_token: "captcha-token" },
    });
    expect(screen.getByRole("status").textContent).toContain("If parent@example.com has");
  });

  test("an invalid email is caught before any request", async () => {
    await renderPage();

    submit("not-an-email");

    expect((await screen.findByRole("alert")).textContent).toBe("Enter a valid email address.");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("a rate-limited request says so and resets the single-use captcha", async () => {
    postMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          status: 429,
          title: "Too Many Requests",
          code: "RATE_LIMIT_EXCEEDED" as never,
          detail: null,
          instance: null,
          type: null,
          request_id: "req-1",
          problem: null,
        }),
      ),
    );
    await renderPage();

    submit("parent@example.com");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many"));
    expect(resetMock).toHaveBeenCalled();
  });
});
