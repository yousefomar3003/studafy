// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApiClient } from "../client";

import { stripUnnormalizedNesting } from "./sanitize";

describe("stripUnnormalizedNesting", () => {
  test("removes un-normalized nested sub-objects but keeps primitives and arrays", () => {
    const result = stripUnnormalizedNesting(
      { id: "1", count: 3, tags: ["a", "b"], nested: { drop: "me" } },
      new Set(),
    );
    expect(result).toEqual({ id: "1", count: 3, tags: ["a", "b"] });
  });

  test("keeps allow-listed nested keys (composite relational payloads)", () => {
    const result = stripUnnormalizedNesting(
      { event_id: "e1", data: { school_id: "s1" }, extra: { drop: "me" } },
      new Set(["data"]),
    );
    expect(result).toEqual({ event_id: "e1", data: { school_id: "s1" } });
  });
});

/** Captures the outbound Request and answers the webhook's 200. */
function capturingFetch(): { fetch: typeof globalThis.fetch; last: () => Request | undefined } {
  let captured: Request | undefined;
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    captured = input instanceof Request ? input : new Request(String(input), init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, last: () => captured };
}

const webhookBody = {
  event_id: "e1",
  doctype: "Sales Invoice",
  action: "on_submit",
  data: { school_id: "s1", total: 10 },
};

describe("sanitizeMiddleware (via the client)", () => {
  test("strips nested sub-objects from the JSON body when enabled with no allowlist", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({ baseUrl: "http://api.test", sanitize: true, fetch });

    await client.POST("/erpnext/webhooks", {
      params: { header: { "x-erpnext-signature": "sig" } },
      body: webhookBody,
    });

    const sent = (await last()!.json()) as Record<string, unknown>;
    expect(sent).toEqual({ event_id: "e1", doctype: "Sales Invoice", action: "on_submit" });
    expect(sent).not.toHaveProperty("data");
  });

  test("preserves an allow-listed composite payload", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({
      baseUrl: "http://api.test",
      sanitize: { allowNested: ["data"] },
      fetch,
    });

    await client.POST("/erpnext/webhooks", {
      params: { header: { "x-erpnext-signature": "sig" } },
      body: webhookBody,
    });

    const sent = (await last()!.json()) as Record<string, unknown>;
    expect(sent.data).toEqual({ school_id: "s1", total: 10 });
  });

  test("is inert by default (opt-in), leaving nested payloads untouched", async () => {
    const { fetch, last } = capturingFetch();
    const client = createApiClient({ baseUrl: "http://api.test", fetch });

    await client.POST("/erpnext/webhooks", {
      params: { header: { "x-erpnext-signature": "sig" } },
      body: webhookBody,
    });

    const sent = (await last()!.json()) as Record<string, unknown>;
    expect(sent.data).toEqual({ school_id: "s1", total: 10 });
  });
});
