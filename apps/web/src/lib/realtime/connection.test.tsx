import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { RealtimeClient } from "./client";
import { RealtimeProvider, useRealtimeConnection } from "./connection";

import type { RealtimeSocket } from "./client";

/** Minimal controllable socket for the provider/hook lifecycle test. */
class FakeSocket implements RealtimeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly open = new Set<() => void>();
  private readonly message = new Set<(data: unknown) => void>();
  private readonly closeHandlers = new Set<(info: { code: number; reason: string }) => void>();
  private readonly error = new Set<() => void>();

  onOpen(handler: () => void): () => void {
    this.open.add(handler);
    return () => this.open.delete(handler);
  }

  onMessage(handler: (data: unknown) => void): () => void {
    this.message.add(handler);
    return () => this.message.delete(handler);
  }

  onClose(handler: (info: { code: number; reason: string }) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: () => void): () => void {
    this.error.add(handler);
    return () => this.error.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    for (const handler of [...this.open]) {
      handler();
    }
  }

  emitClose(code: number): void {
    this.readyState = 3;
    for (const handler of [...this.closeHandlers]) {
      handler({ code, reason: "" });
    }
  }
}

function createClient(socket: FakeSocket): RealtimeClient {
  return new RealtimeClient({
    baseUrl: "ws://localhost:3001",
    getToken: () => "jwt",
    queryClient: new QueryClient(),
    socketFactory: () => socket,
  });
}

function StatusProbe() {
  return <span data-testid="status">{useRealtimeConnection()}</span>;
}

afterEach(cleanup);

describe("useRealtimeConnection", () => {
  test("tracks status transitions from the provider lifecycle", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);

    render(
      <RealtimeProvider client={client}>
        <StatusProbe />
      </RealtimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connecting"));
    expect(client.getStatus()).toBe("connecting");

    act(() => socket.emitOpen());
    expect(screen.getByTestId("status").textContent).toBe("connected");

    act(() => socket.emitClose(1006));
    expect(screen.getByTestId("status").textContent).toBe("reconnecting");
  });

  test("disconnects (closes the socket) on unmount", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);

    const { unmount } = render(
      <RealtimeProvider client={client}>
        <StatusProbe />
      </RealtimeProvider>,
    );
    await waitFor(() => expect(client.getStatus()).toBe("connecting"));
    act(() => socket.emitOpen());
    expect(client.getStatus()).toBe("connected");

    unmount();
    expect(client.getStatus()).toBe("idle");
    expect(socket.readyState).toBe(3);
  });

  test("throws outside a RealtimeProvider", () => {
    // React logs the boundary-caught error in dev; keep the suite output clean.
    let errorCalls = 0;
    const originalError = console.error;
    console.error = () => {
      errorCalls += 1;
    };

    let caught = "";
    class Boundary extends Component<{ children: ReactNode }, { message: string }> {
      state = { message: "" };

      static getDerivedStateFromError(error: Error) {
        return { message: error.message };
      }

      componentDidCatch(error: Error, _info: ErrorInfo) {
        caught = error.message;
      }

      render() {
        return this.state.message ? null : this.props.children;
      }
    }

    render(
      <Boundary>
        <StatusProbe />
      </Boundary>,
    );
    console.error = originalError;
    expect(caught).toBe("useRealtime must be used within a RealtimeProvider");
    expect(errorCalls).toBeGreaterThan(0);
  });
});
