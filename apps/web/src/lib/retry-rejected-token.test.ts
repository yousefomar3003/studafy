// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { retryOnRejectedToken } from "./retry-rejected-token";

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ status, code }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });

function sessionWith(tokenAfterRestore: string | null) {
  return {
    restore: mock(async () => "authenticated"),
    getToken: mock(async () => tokenAfterRestore),
  };
}

const request = () =>
  new Request("http://api.test/api/users/status-counts", {
    headers: { Authorization: "Bearer old-token" },
  });

describe("retryOnRejectedToken", () => {
  test("refreshes once and replays a request whose token the API rejected", async () => {
    const sent: string[] = [];
    const baseFetch = mock(async (input: RequestInfo | URL) => {
      const auth = (input as Request).headers.get("Authorization") ?? "";
      sent.push(auth);
      return auth === "Bearer new-token"
        ? new Response("{}", { status: 200 })
        : problem(401, "AUTH_TOKEN_INVALID");
    });
    const session = sessionWith("new-token");

    const response = await retryOnRejectedToken(session, baseFetch)(request());

    expect(response.status).toBe(200);
    expect(session.restore).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["Bearer old-token", "Bearer new-token"]);
  });

  test("leaves every other 401 alone", async () => {
    const baseFetch = mock(async () => problem(401, "AUTH_TOKEN_EXPIRED"));
    const session = sessionWith("new-token");

    const response = await retryOnRejectedToken(session, baseFetch)(request());

    expect(response.status).toBe(401);
    expect(session.restore).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  test("does not replay when the refresh brings no new token", async () => {
    const baseFetch = mock(async () => problem(401, "AUTH_TOKEN_INVALID"));

    for (const token of [null, "old-token"]) {
      baseFetch.mockClear();
      const response = await retryOnRejectedToken(sessionWith(token), baseFetch)(request());
      expect(response.status).toBe(401);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    }
  });

  test("passes successful responses straight through", async () => {
    const baseFetch = mock(async () => new Response("{}", { status: 200 }));
    const session = sessionWith("new-token");

    expect((await retryOnRejectedToken(session, baseFetch)(request())).status).toBe(200);
    expect(session.restore).not.toHaveBeenCalled();
  });
});
