import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

let scheduledFor: string | null = null;
let cancelError: unknown = null;
let legalRequired = false;
let legalAcceptedAt: string | null = null;

const getMock = mock((_path: string) =>
  Promise.resolve({
    data: {
      deletion_scheduled_for: scheduledFor,
      legal_acceptance: {
        required: legalRequired,
        terms_version: "2026-11-11",
        privacy_version: "2026-11-11",
        accepted_at: legalAcceptedAt,
      },
    },
  }),
);
const deleteMock = mock((_path: string) => Promise.resolve({ error: cancelError }));
const postMock = mock((_path: string, _init: unknown) =>
  Promise.resolve<{ error: unknown }>({ error: { code: "LEGAL_VERSION_OUTDATED" } }),
);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, DELETE: deleteMock, POST: postMock },
}));

async function renderGate() {
  const { DeletionPendingGate } = await import("./DeletionPendingGate");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createSessionStore({
    refreshClient: {
      refresh: async () => {
        throw new Error("not used");
      },
      logout: async () => undefined,
    },
  });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DeletionPendingGate>
            <p>portal content</p>
          </DeletionPendingGate>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  scheduledFor = null;
  cancelError = null;
  legalRequired = false;
  legalAcceptedAt = null;
  postMock.mockClear();
  getMock.mockClear();
  deleteMock.mockClear();
});

describe("DeletionPendingGate", () => {
  test("renders the content when no deletion is scheduled", async () => {
    await renderGate();

    expect(await screen.findByText("portal content")).toBeTruthy();
  });

  test("replaces the content with cancel / sign out while a deletion is scheduled", async () => {
    scheduledFor = "2026-11-01T00:00:00.000Z";
    await renderGate();

    expect(
      await screen.findByRole("heading", { name: "Your account is scheduled for deletion" }),
    ).toBeTruthy();
    expect(screen.queryByText("portal content")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  test("a failed cancel says so and stays on the gate", async () => {
    scheduledFor = "2026-11-01T00:00:00.000Z";
    cancelError = { code: "INTERNAL_ERROR" };
    await renderGate();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel deletion" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/api/account/deletion"));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  test("holds the content back until the user accepts the terms", async () => {
    legalRequired = true;
    await renderGate();

    expect(await screen.findByRole("heading", { name: "Before you continue" })).toBeTruthy();
    expect(screen.queryByText("portal content")).toBeNull();
    expect(screen.getByRole("link", { name: /Terms of Service/ }).getAttribute("href")).toBe(
      "/terms",
    );

    // Not ticked: nothing is sent.
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));
    expect(await screen.findByText(/Tick the box/)).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    // Ticked: the current versions are sent; an outdated answer is explained.
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept the Terms of Service/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![0]).toBe("/api/account/legal-acceptance");
    expect(postMock.mock.calls[0]![1]).toEqual({
      body: { terms_version: "2026-11-11", privacy_version: "2026-11-11" },
    });
    expect(await screen.findByText(/The terms changed while this page was open/)).toBeTruthy();
  });

  test("says the terms were updated when the user had accepted an earlier version", async () => {
    legalRequired = true;
    legalAcceptedAt = "2026-01-01T00:00:00.000Z";
    await renderGate();

    expect(await screen.findByRole("heading", { name: "We have updated our terms" })).toBeTruthy();
  });
});
