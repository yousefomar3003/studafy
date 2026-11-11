import { cleanup, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { createSessionStore } from "../lib/auth";
import { REALTIME_ENABLED } from "../lib/config";

import { AppProviders, createInertRealtimeSocket } from "./providers";

afterEach(cleanup);

/** A store with a live session, restored before render so the realtime gate sees "authenticated". */
async function signedInStore() {
  const store = createSessionStore({
    refreshClient: {
      refresh: async () => ({
        accessToken: "test-token",
        expiresAt: Date.now() + 3_600_000,
        sessionId: "s",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();
  return store;
}

function renderProviders(store: Awaited<ReturnType<typeof signedInStore>>, enabled: boolean) {
  const getTicket = mock(() => "ticket");
  const socketFactory = mock(createInertRealtimeSocket);
  render(
    <AppProviders
      sessionStore={store}
      realtimeSocketFactory={socketFactory}
      realtimeGetTicket={getTicket}
      realtimeEnabled={enabled}
    >
      <p>page</p>
    </AppProviders>,
  );
  return { getTicket, socketFactory };
}

describe("AppProviders realtime gate", () => {
  test("realtime is off unless the build sets VITE_REALTIME_ENABLED=true", () => {
    expect(REALTIME_ENABLED).toBe(false);
  });

  test("with realtime off, a signed-in session never asks for a ticket or opens a socket", async () => {
    const { getTicket, socketFactory } = renderProviders(await signedInStore(), false);
    await screen.findByText("page");
    // Give any connect attempt the effect + microtask turns it would need to start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getTicket).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  test("with realtime on, a signed-in session connects", async () => {
    const { getTicket, socketFactory } = renderProviders(await signedInStore(), true);
    await screen.findByText("page");
    await waitFor(() => expect(socketFactory).toHaveBeenCalled());
    expect(getTicket).toHaveBeenCalled();
  });
});
