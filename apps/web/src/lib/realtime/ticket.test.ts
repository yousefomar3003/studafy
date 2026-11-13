// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { fetchRealtimeTicket } from "./ticket";

const API = "https://api.studafy.test";

function respond(status: number, body: unknown = {}) {
  return mock((_url: URL | RequestInfo, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

describe("fetchRealtimeTicket", () => {
  test("exchanges the access token for a ticket, sending the token only as a bearer header", async () => {
    const fetchFn = respond(200, { ticket: "t.i.cket", expires_at: "2026-11-03T12:00:30.000Z" });

    const ticket = await fetchRealtimeTicket({
      apiBaseUrl: API,
      getAccessToken: () => Promise.resolve("access-token"),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(ticket).toBe("t.i.cket");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/api/realtime/ticket`);
    expect(String(url)).not.toContain("access-token");
    expect(init?.headers).toEqual({ Authorization: "Bearer access-token" });
    expect(init?.cache).toBe("no-store");
  });

  test("resolves null without a session, and asks the API nothing", async () => {
    const fetchFn = respond(200);
    expect(
      await fetchRealtimeTicket({
        apiBaseUrl: API,
        getAccessToken: () => Promise.resolve(null),
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test.each([401, 403])("resolves null when the API refuses the session (%d)", async (status) => {
    expect(
      await fetchRealtimeTicket({
        apiBaseUrl: API,
        getAccessToken: () => Promise.resolve("revoked"),
        fetchFn: respond(status) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  test("throws on a server error or an empty body, so the client retries", async () => {
    for (const fetchFn of [respond(503), respond(200, {})]) {
      await expect(
        fetchRealtimeTicket({
          apiBaseUrl: API,
          getAccessToken: () => Promise.resolve("access-token"),
          fetchFn: fetchFn as unknown as typeof fetch,
        }),
      ).rejects.toThrow();
    }
  });
});
