import { ApiError } from "@studafy/api-client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

import type { ComponentType } from "react";

/** Where the emailed link lands (ST-302). `../../lib/api` is stubbed. */

const TOKEN = "a".repeat(64);

const CONFIRMED = {
  accounts: [
    {
      school_name: "Hill School",
      request_id: "00000000-0000-4000-8000-000000000001",
      completes_by: "2026-10-27T00:00:00.000Z",
    },
  ],
  retained_records: [
    {
      category: "attendance",
      description: "Attendance marks the school recorded, without your name or contact details.",
      legal_basis: "GDPR Art. 17(3)(b)",
    },
  ],
};

const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: CONFIRMED }),
);
mock.module("../../lib/api", () => ({ api: { POST: postMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./ConfirmAccountDeletionPage")).default;

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

const deleteButton = () => screen.getByRole("button", { name: /delete my account/i });

afterEach(() => {
  cleanup();
  postMock.mockClear();
});

describe("ConfirmAccountDeletionPage", () => {
  test("deletes nothing until the button is pressed, and drops the token from the URL", async () => {
    await renderAt(`/legal/delete-account/confirm#token=${TOKEN}`);

    expect(deleteButton()).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("url").textContent).toBe("/legal/delete-account/confirm");
  });

  test("confirming sends the token and shows what was deleted and kept", async () => {
    await renderAt(`/legal/delete-account/confirm#token=${TOKEN}`);

    fireEvent.click(deleteButton());

    await screen.findByRole("heading", { name: /your account has been deleted/i });
    expect(postMock).toHaveBeenCalledWith("/api/account/deletion-requests/confirm", {
      body: { token: TOKEN },
    });
    expect(screen.getByRole("status").textContent).toContain("Hill School");
    expect(screen.getByText(/attendance marks the school recorded/i)).toBeTruthy();
  });

  test("an address with no active account says so", async () => {
    postMock.mockImplementationOnce(() =>
      Promise.resolve({ data: { accounts: [], retained_records: [] } }),
    );
    await renderAt(`/legal/delete-account/confirm#token=${TOKEN}`);

    fireEvent.click(deleteButton());

    await screen.findByRole("heading", { name: /nothing to delete/i });
  });

  test("an invalid or used link explains and offers a new one", async () => {
    postMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          status: 400,
          title: "Bad Request",
          code: "VERIFICATION_TOKEN_INVALID" as never,
          detail: "This deletion link is invalid or has expired. Request a new one.",
          instance: null,
          type: null,
          request_id: "req-1",
          problem: null,
        }),
      ),
    );
    await renderAt(`/legal/delete-account/confirm#token=${TOKEN}`);

    fireEvent.click(deleteButton());

    expect((await screen.findByRole("alert")).textContent).toContain("already been used");
    expect(screen.getByRole("link", { name: /request a new link/i }).getAttribute("href")).toBe(
      "/legal/delete-account",
    );
  });

  test("a link without a token offers a new one and no delete button", async () => {
    await renderAt("/legal/delete-account/confirm");

    expect(screen.getByRole("alert").textContent).toContain("incomplete");
    expect(screen.queryByRole("button", { name: /delete my account/i })).toBeNull();
  });
});
