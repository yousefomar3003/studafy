import { createApiClient } from "@studafy/api-client";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { startProviderLink } from "./provider-link";

describe("startProviderLink", () => {
  test("sends credentials so the browser keeps the OAuth binding cookie, then navigates", async () => {
    const requests: Request[] = [];
    const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(String(input), init));
      return new Response(JSON.stringify({ redirect_url: "https://accounts.example/authorize" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const client = createApiClient({ baseUrl: "https://api.test", fetch });
    const visited: string[] = [];

    await startProviderLink("google", client, (url) => visited.push(url));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.test/api/auth/providers/link/start");
    expect(requests[0]!.credentials).toBe("include");
    expect(await requests[0]!.json()).toEqual({ provider: "google" });
    expect(visited).toEqual(["https://accounts.example/authorize"]);
  });
});
