import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

let scheduledFor: string | null = null;
let cancelError: unknown = null;

const getMock = mock((_path: string) =>
  Promise.resolve({ data: { deletion_scheduled_for: scheduledFor } }),
);
const deleteMock = mock((_path: string) => Promise.resolve({ error: cancelError }));

mock.module("../../../lib/api", () => ({ api: { GET: getMock, DELETE: deleteMock } }));

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
        <DeletionPendingGate>
          <p>portal content</p>
        </DeletionPendingGate>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  scheduledFor = null;
  cancelError = null;
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
});
